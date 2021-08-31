import Websocket, { Server } from "ws";
import { Server as HttpServer } from "http";
import { WrappedNodeRedisClient } from "handy-redis";
import { ORIGIN } from "./constants";
import {
  AuthEvent,
  ClientEventNames,
  JoinRoomEvent,
  WsEvent,
  OfflineEvent,
} from "./interface/events.interface";
import NRP from "node-redis-pubsub";
import CacheService from "./services/cache.service";
import { getJwtPayloadFromToken } from "./utils";
import userService from "./services/user.service";
import Subscriber from "./subscriber";
import MessageHandler from "./socket_message_handler";

export default (
  httpServer: HttpServer,
  redisClient: WrappedNodeRedisClient,
  pid: number,
) => {
  /**
   * Store an internal Map of the connected clients in each cluster,
   * using their username as the key and the `ws` as the value,
   * then save the usernames of the connected clients to Redis
   */
  const connectedClientSockets = new Map<string, Websocket>();

  const Wss = new Server({ noServer: true }),
    cacheService = new CacheService(redisClient),
    nrp = new NRP.NodeRedisPubSub({ port: 6379 }),
    messageHandler = new MessageHandler(pid, nrp, Wss, cacheService);

  // handle the events published by another cluster
  const sub = new Subscriber(pid, Wss);

  // associate all the events to listen for
  nrp.on("joinRoom", sub.handleJoinRoom);
  nrp.on("roomUsersOnline", sub.handleRoomUsersOnline);
  nrp.on("online", sub.handleOnline);
  nrp.on("offline", sub.handleOffline);
  nrp.on("allUsersOnline", sub.handleAllUsersOnline);

  // handle upgrade events from the server
  httpServer.on("upgrade", (req, socket, head) => {
    // check for the origin
    const origin = req.headers.origin,
      NODE_ENV = process.env.NODE_ENV;

    if (!origin) {
      socket.write("HTTP/1.1 401 Unauthorized");
      socket.destroy();
      return;
    }

    if (NODE_ENV === "development") {
      if (origin !== "http://localhost:3000") {
        socket.write("HTTP/1.1 401 Unauthorized");
        socket.destroy();
        return;
      }
    }

    if (NODE_ENV === "production") {
      if (origin !== ORIGIN) {
        socket.write("HTTP/1.1 401 Unauthorized");
        socket.destroy();
        return;
      }
    }

    // handle the upgrade
    // @ts-ignore
    Wss.handleUpgrade(req, socket, head, (ws, req) => {
      Wss.emit("connection", ws, req);
    });
  });

  Wss.on("connection", (ws, _) => {
    let username: string;

    // register the socket
    ws.on("message", async (data: WsEvent<string, any>) => {
      let eventName = data[0] as ClientEventNames;

      /**
       * When a client comes online, the first message to be sent
       * is the `authentication` event.
       * If the authentication is successful, initialise
       * the username field.
       * Save the client's username to Redis and update the `connectedClientSockets`
       */
      if (eventName === "authentication") {
        const [_, message] = data as AuthEvent;
        const payload = getJwtPayloadFromToken(message.accessToken);
        if (!payload.username) {
          ws.close(1, "Unauthorised");
          return;
        }

        username = payload.username;
        connectedClientSockets.set(username, ws);
        messageHandler.handleAuthentication(username);
      } else {
        if (!(await cacheService.getClient(data[1].username))) {
          ws.close(1, "Unauthorised");
          return;
        }

        // handle the various messages from the clients
        switch (eventName) {
          case "joinRoom":
            let [_, message] = data as JoinRoomEvent;
            messageHandler.handleJoinRoom(message);
            break;
          case "chatMessage":
            // not implemented
            break;
          case "leaveRoom":
            // not implemented
            break;
        }
      }
    });

    /**
     * Handle the connection close event
     * send a close event to all connected clients
     */
    ws.on("close", async () => {
      await cacheService.removeFromConnectedClients(username);
      connectedClientSockets.delete(username);

      for await (let ws of Wss.clients) {
        const roomNames = (await userService.getUserRooms(
          undefined,
          username,
        )) as string[];

        if (roomNames?.length > 0) {
          const onlineData: OfflineEvent = [
            "offline",
            {
              username,
              roomNames,
            },
          ];
          ws.send(onlineData);
        }
      }

      nrp.emit("offline", JSON.stringify(["offline", { username }, pid]));
    });
  });
};

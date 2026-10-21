// Socket.IO authentication and room membership, using the same rules as the
// REST `protect` middleware (resolveActiveUser).
//
//  - Handshake: Bearer access token in `auth.token` (or an Authorization
//    header). Cookies are deliberately NOT accepted here: a WebSocket opened
//    from another site would carry them automatically.
//  - Rooms are assigned by the server from the verified user's role; clients
//    have no way to join or name a room.
//  - A socket is disconnected when its token expires, and when its account is
//    blocked / suspended / deleted (checked whenever a user record changes),
//    matching what REST would answer to that user's next request.

import { resolveActiveUser } from "../middlewares/auth.middleware.js";
import User, { USER_ROLES } from "../models/user.model.js";

export const DASHBOARD_ROOM = "dashboard";

// Roles that receive dashboard change events. Same as REST today: the
// dashboard data is readable by every signed-in role. Narrow this list to
// restrict who gets live updates.
export const DASHBOARD_ROLES = new Set(USER_ROLES);

const MAX_TIMER_MS = 2 ** 31 - 1; // setTimeout limit (~24.8 days)

export function tokenFromHandshake(handshake) {
  const fromAuth = handshake?.auth?.token;
  if (typeof fromAuth === "string" && fromAuth) {
    return fromAuth.startsWith("Bearer ") ? fromAuth.slice(7) : fromAuth;
  }
  const header = handshake?.headers?.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    return header.slice(7);
  }
  return null;
}

// io.use() middleware: rejects the connection unless the token is valid and
// the account is active. The client sees connect_error with err.data.status.
// Only resolveActiveUser's own 401/403 mean "not allowed"; anything else
// (e.g. the database not answering) is 503, so the client retries instead of
// treating its login as invalid. REST answers those with 500, not 401.
export async function authenticateSocket(socket, next) {
  try {
    const { user, decoded } = await resolveActiveUser(
      tokenFromHandshake(socket.handshake),
    );
    socket.data.userId = String(user._id);
    socket.data.role = user.role;
    socket.data.tokenExp = typeof decoded.exp === "number" ? decoded.exp : null;
    next();
  } catch (err) {
    const status =
      err?.statusCode === 401 || err?.statusCode === 403 ? err.statusCode : 503;
    const error = new Error(
      status === 401 ? "unauthorized" : status === 403 ? "forbidden" : "unavailable",
    );
    error.data = {
      status,
      message: status === 503 ? "Authentication check failed, retry later" : err.message,
    };
    if (status === 503) {
      // name/code only: driver messages can include connection details
      console.error(
        `[realtime] socket auth check failed (503): ${err?.name || "Error"}` +
          (err?.code ? ` ${err.code}` : ""),
      );
    } else {
      console.warn(
        `[realtime] socket rejected (${status}): ${err.message} [${socket.handshake.address}]`,
      );
    }
    next(error);
  }
}

function endSession(socket, reason) {
  socket.emit("realtime:session_ended", { reason });
  socket.disconnect(true);
}

export function applyRooms(socket) {
  if (DASHBOARD_ROLES.has(socket.data.role)) socket.join(DASHBOARD_ROOM);
  else socket.leave(DASHBOARD_ROOM);
  return socket.rooms.has(DASHBOARD_ROOM);
}

export function scheduleTokenExpiry(socket) {
  clearTimeout(socket.data.expiryTimer);
  if (!socket.data.tokenExp) return;

  const msLeft = socket.data.tokenExp * 1000 - Date.now();
  if (msLeft <= 0) return endSession(socket, "token_expired");

  socket.data.expiryTimer = setTimeout(
    () => scheduleTokenExpiry(socket), // re-checks; long tokens hop in steps
    Math.min(msLeft, MAX_TIMER_MS),
  );
  socket.data.expiryTimer.unref?.();
}

export function clearSocketTimers(socket) {
  clearTimeout(socket.data.expiryTimer);
}

// Re-check every connected account (after any change to user records).
export async function revalidateSockets(io) {
  if (!io) return;
  const sockets = [...io.of("/").sockets.values()];
  if (!sockets.length) return;

  const ids = [...new Set(sockets.map((s) => s.data.userId).filter(Boolean))];
  const users = await User.find({ _id: { $in: ids } })
    .select("_id role accountStatus deletedAt")
    .lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));

  for (const socket of sockets) {
    const user = byId.get(socket.data.userId);
    if (!user || user.accountStatus !== "ACTIVE" || user.deletedAt) {
      endSession(socket, "access_revoked");
      continue;
    }
    if (user.role !== socket.data.role) {
      socket.data.role = user.role;
      applyRooms(socket);
    }
  }
}

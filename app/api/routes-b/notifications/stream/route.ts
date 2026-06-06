/**
 * GET /api/routes-b/notifications/stream
 * Server-sent events feed for real-time notifications.
 *
 * Holds a persistent connection and pushes new notifications as SSE events.
 * Sends heartbeat ping every 30s to keep proxies alive.
 * Connections are capped at 5 per user.
 */

import { NextRequest, NextResponse } from "next/server";
import { verifyAuthToken } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  subscribe,
  unsubscribe,
  waitForEvent,
  getSubscriberCount,
} from "../../_lib/event-bus";
import { logger } from "@/lib/logger";

const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const EVENT_TIMEOUT = 60000; // 1 minute timeout for waiting for events

async function GETHandler(request: NextRequest) {
  try {
    // Authenticate
    const authToken = request.headers
      .get("authorization")
      ?.replace("Bearer ", "");
    if (!authToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const claims = await verifyAuthToken(authToken);
    if (!claims) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
    });
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Subscribe to events
    const subscriptionId = subscribe(user.id, () => {
      // Handler is called when events are published, but we use waitForEvent instead
    });

    if (!subscriptionId) {
      return NextResponse.json(
        { error: "Too many connections (max 5 per user)" },
        { status: 429 },
      );
    }

    // Create SSE stream
    const encoder = new TextEncoder();
    let isClosed = false;

    const stream = new ReadableStream({
      async start(controller) {
        try {
          // Send initial connection message
          controller.enqueue(
            encoder.encode(
              'event: connected\ndata: {"status":"connected"}\n\n',
            ),
          );

          // Heartbeat and event loop
          const heartbeatInterval = setInterval(() => {
            if (isClosed) {
              clearInterval(heartbeatInterval);
              return;
            }
            // Send heartbeat ping
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
          }, HEARTBEAT_INTERVAL);

          // Wait for events
          while (!isClosed) {
            const event = await waitForEvent(subscriptionId, EVENT_TIMEOUT);

            if (event) {
              // Send event as SSE
              const sseEvent = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
              controller.enqueue(encoder.encode(sseEvent));
            } else {
              // Timeout - send heartbeat
              controller.enqueue(encoder.encode(": heartbeat\n\n"));
            }
          }

          clearInterval(heartbeatInterval);
          controller.close();
        } catch (error) {
          logger.error({ err: error, userId: user.id }, "SSE stream error");
          controller.error(error);
        }
      },

      cancel() {
        isClosed = true;
        unsubscribe(subscriptionId);
      },
    });

    return new NextResponse(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no", // Disable proxy buffering
      },
    });
  } catch (error) {
    logger.error({ err: error }, "SSE stream handler error");
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

export const GET = GETHandler;

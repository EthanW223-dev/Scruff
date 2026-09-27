import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import { z } from "zod";
import { defineTool, type HubTool } from "./tools.ts";

interface PendingFrame {
  resolve(jpegBase64: string): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

const FRAME_TIMEOUT_MS = 8000;

/**
 * Lets Claude see the game. The dashboard shares the game window through the browser's
 * screen-capture picker, and grabs a frame whenever Claude asks for one.
 */
export class ScreenBridge extends EventEmitter {
  private sharers = new Set<WebSocket>();
  private pending = new Map<string, PendingFrame>();
  private nextId = 1;

  get active(): boolean {
    return this.sharers.size > 0;
  }

  setSharing(ws: WebSocket, sharing: boolean): void {
    if (sharing) this.sharers.add(ws);
    else this.sharers.delete(ws);
    this.emit("update");
  }

  frame(id: string, data: string | undefined, error: string | undefined): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (data) p.resolve(data);
    else p.reject(new Error(error ?? "The dashboard couldn't capture a frame."));
  }

  capture(): Promise<string> {
    const sharer = [...this.sharers].at(-1);
    if (!sharer) {
      return Promise.reject(
        new Error("Screen sharing is off. Ask the user to click 'Share screen' in the Scruff dashboard and pick the game window."),
      );
    }
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Timed out waiting for a screenshot from the dashboard."));
      }, FRAME_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      sharer.send(JSON.stringify({ type: "capture", id }));
    });
  }

  tools(): HubTool[] {
    return [
      defineTool({
        name: "look_at_screen",
        description:
          "Take a screenshot of the game (shared from the dashboard) to see what the player sees: numbers on the HUD, " +
          "menus, what's happening. Useful before a memory scan to read the exact value to search for.",
        input: z.object({}),
        run: async (_input, ctx) => {
          ctx.progress("Looking at the screen…");
          const data = await this.capture();
          return [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data } }];
        },
      }),
    ];
  }
}

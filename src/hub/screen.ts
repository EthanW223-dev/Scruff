import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import { z } from "zod";
import { defineTool, json, type HubTool } from "./tools.ts";
import { confirmQuestion, parseConfirm, parseVisual, visualQuestion, type VisionClient } from "./vision.ts";

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

  tools(vision?: () => VisionClient | null): HubTool[] {
    return [
      defineTool({
        name: "look_at_screen",
        readOnly: true,
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
      defineTool({
        name: "verify_on_screen",
        readOnly: true,
        description:
          "Check whether the game's HUD actually shows a value you just wrote with write_value. A write can " +
          "stick in memory at an address that is only a copy of the real value, so the game never shows it: " +
          "always verify on screen before telling the player it worked. Returns yes (the HUD shows it), no " +
          "(visible but different: undo and try the next candidate address one at a time), or unknown (the " +
          "counter isn't on screen right now: don't treat that as a failure).",
        input: z.object({
          what: z.string().describe("What was changed, e.g. 'soup cans'"),
          expected: z.number().describe("The number the HUD should show now"),
        }),
        run: async ({ what, expected }, ctx) => {
          const vc = vision?.();
          if (!vc) {
            throw new Error(
              "No vision model is set up: pick Claude or a local vision model (e.g. ollama pull qwen3-vl) in the AI menu.",
            );
          }
          ctx.progress("Checking the game screen…");
          const data = await this.capture();
          const reply = await vc.ask(data, confirmQuestion(what, fmtNum(expected)), ctx.signal);
          return json({ verdict: parseConfirm(reply, expected), model_said: reply });
        },
      }),
      defineTool({
        name: "verify_visual_change",
        readOnly: true,
        description:
          "Check whether a visual mod actually showed up in the game (recolor, hide/remove, spawn, " +
          "move/resize, slow motion). Call it after every bridge mod, the way verify_on_screen follows a " +
          "memory write: if the screen says no, undo the change and try the next candidate object. " +
          "Returns yes (visible), no (scene visible but unchanged: undo and retry), or unknown " +
          "(can't tell from this shot: don't treat that as a failure).",
        input: z.object({
          change: z.string().describe("What was supposed to visibly change, e.g. 'the trees are purple'"),
        }),
        run: async ({ change }, ctx) => {
          const vc = vision?.();
          if (!vc) {
            throw new Error(
              "No vision model is set up: pick Claude or a local vision model (e.g. ollama pull qwen3-vl) in the AI menu.",
            );
          }
          ctx.progress("Checking the game screen…");
          const data = await this.capture();
          const reply = await vc.ask(data, visualQuestion(change), ctx.signal);
          return json({ verdict: parseVisual(reply), model_said: reply });
        },
      }),
    ];
  }
}

/** Short number formatting shared with the fast path. */
export function fmtNum(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString("en-US") : String(Math.round(n * 1000) / 1000);
}

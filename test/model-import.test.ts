import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import { findModelFiles } from "../src/hub/modelfiles.ts";

// load_model's file reading (bridge/src/ModelFile.cs) on plain Mono: glTF/GLB and OBJ in, the
// mesh data the Unity side builds out — in Unity's left-handed space, textures included.
// Needs Mono (apt install mono-mcs mono-runtime); skipped without it.

const root = path.resolve(import.meta.dirname, "..");
const hasMono = (() => {
  try {
    execFileSync("mcs", ["--version"], { stdio: "ignore" });
    execFileSync("mono", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

let dir: string;
let exe: string;

before(() => {
  if (!hasMono) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "telos-model-"));
  exe = path.join(dir, "ModelDump.exe");
  execFileSync("mcs", [
    "-nologo",
    "-langversion:6",
    `-out:${exe}`,
    path.join(root, "bridge", "src", "ModelFile.cs"),
    path.join(root, "bridge", "src", "Json.cs"),
    path.join(root, "test", "fixtures", "bridge", "ModelDump.cs"),
  ]);
});

interface Dump {
  error?: string;
  bounds: number[];
  parts: { name: string; positions: number[]; normals: number[] | null; uvs: number[] | null; indices: number[]; color: number[]; texture: number }[];
}

function dump(file: string, split?: number): Dump {
  const r = spawnSync("mono", [exe, file, ...(split ? [String(split)] : [])], { encoding: "utf8" });
  return JSON.parse(r.stdout);
}

const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex"); // a PNG header is enough here

/** A glTF document plus its binary data, as .glb or as .gltf with a data: URI or a .bin next to it. */
function gltf(opts: { translation?: number[]; scale?: number[]; texture?: boolean; extensionsRequired?: string[] } = {}) {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const nrm = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const uv = new Float32Array([0, 0, 1, 0, 0, 1]);
  const idx = new Uint16Array([0, 1, 2, 0]); // padded to 4 bytes
  const chunks = [Buffer.from(pos.buffer), Buffer.from(nrm.buffer), Buffer.from(uv.buffer), Buffer.from(idx.buffer), ...(opts.texture ? [PNG] : [])];
  const views: { buffer: number; byteOffset: number; byteLength: number }[] = [];
  let offset = 0;
  for (const c of chunks) {
    views.push({ buffer: 0, byteOffset: offset, byteLength: c.length });
    offset += c.length;
  }
  const bin = Buffer.concat(chunks);
  const json: Record<string, unknown> = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: "root", translation: opts.translation, scale: opts.scale, children: [1] }, { mesh: 0 }],
    meshes: [{ name: "tri", primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    materials: [
      { pbrMetallicRoughness: { baseColorFactor: [1, 0.5, 0.25, 1], ...(opts.texture ? { baseColorTexture: { index: 0 } } : {}) } },
    ],
    ...(opts.texture ? { textures: [{ source: 0 }], images: [{ bufferView: 4, mimeType: "image/png" }] } : {}),
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 1, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 2, componentType: 5126, count: 3, type: "VEC2" },
      { bufferView: 3, componentType: 5123, count: 3, type: "SCALAR" },
    ],
    bufferViews: views,
    buffers: [{ byteLength: bin.length }],
    ...(opts.extensionsRequired ? { extensionsRequired: opts.extensionsRequired } : {}),
  };
  return { json, bin };
}

function glb(doc: { json: Record<string, unknown>; bin: Buffer }): Buffer {
  let text = Buffer.from(JSON.stringify(doc.json));
  text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const bin = Buffer.concat([doc.bin, Buffer.alloc((4 - (doc.bin.length % 4)) % 4)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + text.length + 8 + bin.length, 8);
  const chunk = (data: Buffer, type: number) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(data.length, 0);
    h.writeUInt32LE(type, 4);
    return Buffer.concat([h, data]);
  };
  return Buffer.concat([header, chunk(text, 0x4e4f534a), chunk(bin, 0x004e4942)]);
}

test("GLB: node transforms baked in, mirrored into Unity's space, winding and UVs flipped, color and texture kept", { skip: !hasMono && "needs Mono" }, () => {
  const file = path.join(dir, "tri.glb");
  fs.writeFileSync(file, glb(gltf({ translation: [2, 0, 0], scale: [2, 2, 2], texture: true })));
  const out = dump(file);
  assert.equal(out.error, undefined);
  assert.equal(out.parts.length, 1);
  const p = out.parts[0];
  // (0,0,0) (1,0,0) (0,1,0), scaled by 2 and moved +2 on X, then X mirrored.
  assert.deepEqual(p.positions, [-2, 0, 0, -4, 0, 0, -2, 2, 0]);
  assert.deepEqual(p.normals, [0, 0, 1, 0, 0, 1, 0, 0, 1]);
  assert.deepEqual(p.uvs, [0, 1, 1, 1, 0, 0]);
  assert.deepEqual(p.indices, [0, 2, 1]);
  assert.deepEqual(p.color, [1, 0.5, 0.25, 1]);
  assert.equal(p.texture, PNG.length);
  assert.deepEqual(out.bounds, [-4, 0, 0, -2, 2, 0]);
});

test("glTF text files: buffers from a data: URI or a .bin next to the model, but never from elsewhere", { skip: !hasMono && "needs Mono" }, () => {
  const doc = gltf();
  (doc.json.buffers as object[])[0] = { byteLength: doc.bin.length, uri: `data:application/octet-stream;base64,${doc.bin.toString("base64")}` };
  fs.writeFileSync(path.join(dir, "inline.gltf"), JSON.stringify(doc.json));
  assert.deepEqual(dump(path.join(dir, "inline.gltf")).parts[0].indices, [0, 2, 1]);

  const side = gltf();
  (side.json.buffers as object[])[0] = { byteLength: side.bin.length, uri: "tri%20data.bin" };
  fs.writeFileSync(path.join(dir, "tri data.bin"), side.bin);
  fs.writeFileSync(path.join(dir, "side.gltf"), JSON.stringify(side.json));
  assert.equal(dump(path.join(dir, "side.gltf")).parts[0].positions.length, 9);

  (side.json.buffers as object[])[0] = { byteLength: side.bin.length, uri: "../../etc/passwd" };
  fs.writeFileSync(path.join(dir, "escape.gltf"), JSON.stringify(side.json));
  assert.match(dump(path.join(dir, "escape.gltf")).error!, /outside its folder/);
});

test("compressed glTF and other formats get a way forward, not a crash", { skip: !hasMono && "needs Mono" }, () => {
  fs.writeFileSync(path.join(dir, "draco.glb"), glb(gltf({ extensionsRequired: ["KHR_draco_mesh_compression"] })));
  assert.match(dump(path.join(dir, "draco.glb")).error!, /compressed.*Export it again without compression/);
  fs.writeFileSync(path.join(dir, "model.fbx"), "x");
  assert.match(dump(path.join(dir, "model.fbx")).error!, /\.glb, \.gltf and \.obj.*Blender/);
  assert.match(dump(path.join(dir, "missing.glb")).error!, /No file at/);
});

test("OBJ with MTL: quads become triangles, negative indices, materials split parts, textures load", { skip: !hasMono && "needs Mono" }, () => {
  fs.writeFileSync(path.join(dir, "crate.png"), PNG);
  fs.writeFileSync(
    path.join(dir, "crate.mtl"),
    ["newmtl Wood", "Kd 0.8 0.6 0.4", "map_Kd -s 1 1 1 crate.png", "newmtl Paint", "Kd 1 0 0", "d 0.5"].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "crate.obj"),
    [
      "# a quad and a triangle",
      "mtllib crate.mtl",
      "v 0 0 0", "v 1 0 0", "v 1 1 0", "v 0 1 0",
      "vt 0 0", "vt 1 0", "vt 1 1", "vt 0 1",
      "vn 0 0 1",
      "usemtl Wood",
      "f 1/1/1 2/2/1 3/3/1 4/4/1",
      "usemtl Paint",
      "f -4/-4/-1 -3/-3/-1 -2/-2/-1",
    ].join("\n"),
  );
  const out = dump(path.join(dir, "crate.obj"));
  assert.equal(out.error, undefined);
  assert.deepEqual(out.parts.map((p) => p.name), ["Wood", "Paint"]);
  const [wood, paint] = out.parts;
  assert.deepEqual(wood.positions, [0, 0, 0, -1, 0, 0, -1, 1, 0, 0, 1, 0]);
  assert.deepEqual(wood.indices, [0, 2, 1, 0, 3, 2], "a fan, wound for Unity");
  assert.deepEqual(wood.uvs, [0, 0, 1, 0, 1, 1, 0, 1], "OBJ's v already runs up");
  assert.deepEqual(wood.color, [0.8, 0.6, 0.4, 1]);
  assert.equal(wood.texture, PNG.length);
  assert.deepEqual(paint.color, [1, 0, 0, 0.5]);
  assert.equal(paint.texture, 0);
  assert.equal(paint.positions.length, 9);
});

test("big meshes split for old Unity's 65,535-vertex limit, keeping every triangle", { skip: !hasMono && "needs Mono" }, () => {
  const lines: string[] = [];
  for (let t = 0; t < 10; t++) lines.push(`v ${t} 0 0`, `v ${t} 1 0`, `v ${t} 0 1`, `f ${t * 3 + 1} ${t * 3 + 2} ${t * 3 + 3}`);
  fs.writeFileSync(path.join(dir, "many.obj"), lines.join("\n"));
  const whole = dump(path.join(dir, "many.obj"));
  assert.equal(whole.parts.length, 1);
  const split = dump(path.join(dir, "many.obj"), 9);
  assert.deepEqual(split.parts.map((p) => p.indices.length / 3), [3, 3, 3, 1]);
  assert.ok(split.parts.every((p) => p.positions.length / 3 <= 9));
  assert.deepEqual(split.bounds, whole.bounds);
});

test("find_model_files finds exports by name, newest first, and skips everything else", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telos-models-home-"));
  const exports = path.join(home, "Downloads", "FModel", "Output", "Exports", "Game", "Characters");
  fs.mkdirSync(exports, { recursive: true });
  fs.mkdirSync(path.join(home, "Desktop", "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(exports, "Zombie.glb"), "x");
  fs.writeFileSync(path.join(exports, "Zombie.png"), "x");
  fs.writeFileSync(path.join(home, "Desktop", "crate.obj"), "x");
  fs.writeFileSync(path.join(home, "Desktop", "node_modules", "skip.glb"), "x");
  const old = new Date(Date.now() - 86_400_000);
  fs.utimesSync(path.join(home, "Desktop", "crate.obj"), old, old);
  const roots = [path.join(home, "Downloads"), path.join(home, "Desktop")];

  assert.deepEqual(findModelFiles(roots).map((m) => m.name), ["Zombie.glb", "crate.obj"]);
  assert.deepEqual(findModelFiles(roots, "fmodel zombie").map((m) => m.name), ["Zombie.glb"]);
  assert.deepEqual(findModelFiles(roots, "dragon"), []);
});

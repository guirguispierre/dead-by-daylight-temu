// Third-person 3D renderer (three.js/WebGL). The 2D simulation stays
// authoritative: world (x, y) maps to 3D (x, 0, z=y), 1 cell = 1 meter.
// This module only mirrors sim state into meshes; it never mutates it.

import * as THREE from '../vendor/three.module.js';
import { CELL, T } from './map.js';
import { HEALTH, STANCE } from './survivor.js';

const WALL_H = 2.6 * CELL;
const SILL_H = 0.9 * CELL;     // window sill height
const HEAD_H = 1.8 * CELL;     // window header bottom

let renderer = null;
let scene = null;
let camera = null;

// Dynamic mesh registries
let genMeshes = [];
let palletMeshes = [];
let gateGroups = [];
let hatchMesh = null;
let survivorMeshes = new Map();  // survivor object -> mesh group
let killerGroup = null;
let redStain = null;
let scratchPool = [];
let playerLight = null;

const MAT = {
  floor: new THREE.MeshStandardMaterial({ color: 0x16161f, roughness: 1 }),
  wall: new THREE.MeshStandardMaterial({ color: 0x3a3450, roughness: 0.9 }),
  window: new THREE.MeshStandardMaterial({ color: 0x46506a, roughness: 0.9 }),
  gen: new THREE.MeshStandardMaterial({ color: 0xcaa84e, roughness: 0.6 }),
  genDone: new THREE.MeshStandardMaterial({ color: 0xe8e07a, emissive: 0xe8e07a, emissiveIntensity: 0.7 }),
  genRegress: new THREE.MeshStandardMaterial({ color: 0xa84e3a, emissive: 0xa83a2a, emissiveIntensity: 0.4 }),
  hook: new THREE.MeshStandardMaterial({ color: 0x7a4a4a, roughness: 0.8 }),
  pallet: new THREE.MeshStandardMaterial({ color: 0x8a6b43, roughness: 1 }),
  gate: new THREE.MeshStandardMaterial({ color: 0x4e6e4e, roughness: 0.9 }),
  killer: new THREE.MeshStandardMaterial({ color: 0xa32330, roughness: 0.7 }),
  hatch: new THREE.MeshStandardMaterial({ color: 0x05050a, roughness: 1 }),
  scratch: new THREE.MeshBasicMaterial({ color: 0xbe1e23, transparent: true }),
};

export function init3d(canvas, map) {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x07070c);
  scene.fog = new THREE.FogExp2(0x07070c, 0.0022);

  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 4, 2000);

  // Cold moonlight + faint ground bounce
  scene.add(new THREE.HemisphereLight(0x5a6590, 0x262030, 2.2));
  const moon = new THREE.DirectionalLight(0x9aa8d8, 1.4);
  moon.position.set(0.4, 1, 0.25);
  scene.add(moon);

  // Soft lantern that follows the player so the action is always readable
  playerLight = new THREE.PointLight(0xd8c8a0, 30, 14 * CELL, 1.6);
  scene.add(playerLight);

  buildStatic(map);
  buildDynamic(map);

  return { scene, camera };
}

function buildStatic(map) {
  // Floor
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(map.w * CELL, map.h * CELL), MAT.floor);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(map.w * CELL / 2, 0, map.h * CELL / 2);
  scene.add(floor);

  // Walls + window sills/headers as instanced boxes
  const wallCells = [];
  const windowCells = [];
  for (let cy = 0; cy < map.h; cy++) {
    for (let cx = 0; cx < map.w; cx++) {
      const t = map.at(cx, cy);
      if (t === T.WALL) wallCells.push([cx, cy]);
      else if (t === T.WINDOW) windowCells.push([cx, cy]);
    }
  }

  const box = new THREE.BoxGeometry(CELL, 1, CELL);
  const walls = new THREE.InstancedMesh(box, MAT.wall, wallCells.length);
  wallCells.forEach(([cx, cy], i) => {
    const m = new THREE.Matrix4()
      .makeScale(1, WALL_H, 1)
      .setPosition((cx + 0.5) * CELL, WALL_H / 2, (cy + 0.5) * CELL);
    walls.setMatrixAt(i, m);
  });
  scene.add(walls);

  const sills = new THREE.InstancedMesh(box, MAT.window, windowCells.length * 2);
  windowCells.forEach(([cx, cy], i) => {
    const x = (cx + 0.5) * CELL;
    const z = (cy + 0.5) * CELL;
    sills.setMatrixAt(i * 2, new THREE.Matrix4()
      .makeScale(1, SILL_H, 1).setPosition(x, SILL_H / 2, z));
    const headH = WALL_H - HEAD_H;
    sills.setMatrixAt(i * 2 + 1, new THREE.Matrix4()
      .makeScale(1, headH, 1).setPosition(x, HEAD_H + headH / 2, z));
  });
  scene.add(sills);

  // Hooks: post + curve hint
  for (const h of map.hooks) {
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08 * CELL, 0.1 * CELL, 2.4 * CELL, 6), MAT.hook);
    post.position.set(h.x, 1.2 * CELL, h.y);
    scene.add(post);
    const arm = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05 * CELL, 0.05 * CELL, 0.6 * CELL, 6), MAT.hook);
    arm.rotation.z = Math.PI / 2;
    arm.position.set(h.x + 0.3 * CELL, 2.3 * CELL, h.y);
    scene.add(arm);
  }
}

function buildDynamic(map) {
  genMeshes = [];
  palletMeshes = [];
  gateGroups = [];
  survivorMeshes = new Map();
  scratchPool = [];

  // Generators: chunky machines
  for (const g of map.generators) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.9 * CELL, 1.1 * CELL, 0.9 * CELL), MAT.gen);
    mesh.position.set(g.x, 0.55 * CELL, g.y);
    scene.add(mesh);
    const light = new THREE.PointLight(0xe8e07a, 0, 5 * CELL);
    light.position.set(g.x, 1.6 * CELL, g.y);
    scene.add(light);
    genMeshes.push({ g, mesh, light });
  }

  // Pallets: orientation follows the wall run they plug
  for (const p of map.pallets) {
    const alongX = map.at(p.cx - 1, p.cy) === T.WALL || map.at(p.cx + 1, p.cy) === T.WALL;
    const board = new THREE.Mesh(
      new THREE.BoxGeometry(CELL, 1.2 * CELL, 0.15 * CELL), MAT.pallet);
    if (!alongX) board.rotation.y = Math.PI / 2;
    scene.add(board);
    palletMeshes.push({ p, board, alongX });
  }

  // Gates: slabs per cell, hidden when open
  for (const gate of map.gates) {
    const group = new THREE.Group();
    for (const c of gate.cells) {
      const slab = new THREE.Mesh(
        new THREE.BoxGeometry(CELL, WALL_H * 0.95, CELL * 0.8), MAT.gate);
      slab.position.set((c.cx + 0.5) * CELL, WALL_H * 0.475, (c.cy + 0.5) * CELL);
      group.add(slab);
    }
    scene.add(group);
    gateGroups.push({ gate, group });
  }

  // Hatch
  hatchMesh = new THREE.Mesh(new THREE.CircleGeometry(0.7 * CELL, 24), MAT.hatch);
  hatchMesh.rotation.x = -Math.PI / 2;
  hatchMesh.position.set(map.hatch.x, 0.5, map.hatch.y);
  hatchMesh.visible = false;
  scene.add(hatchMesh);

  // Scratch mark pool (flat quads)
  const scratchGeo = new THREE.PlaneGeometry(3, 3);
  for (let i = 0; i < 220; i++) {
    const q = new THREE.Mesh(scratchGeo, MAT.scratch.clone());
    q.rotation.x = -Math.PI / 2;
    q.visible = false;
    scene.add(q);
    scratchPool.push(q);
  }

  // Killer: hulking capsule, glowing eyes, red stain spotlight
  killerGroup = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.45 * CELL, 1.4 * CELL, 4, 10), MAT.killer);
  body.position.y = 1.15 * CELL;
  killerGroup.add(body);
  const eyeGeo = new THREE.SphereGeometry(1.6, 6, 6);
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0xffd9a0 });
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(eyeGeo, eyeMat);
    eye.position.set(side * 3.5, 1.9 * CELL, 0.42 * CELL);
    killerGroup.add(eye);
  }
  redStain = new THREE.SpotLight(0xff2030, 14, 7 * CELL, 0.45, 0.6, 1.2);
  redStain.position.set(0, 1.9 * CELL, 0);
  const stainTarget = new THREE.Object3D();
  stainTarget.position.set(0, 0, 4 * CELL);
  killerGroup.add(stainTarget);
  redStain.target = stainTarget;
  killerGroup.add(redStain);
  scene.add(killerGroup);
}

function survivorMesh(sv, color) {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.8 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.32 * CELL, 1.0 * CELL, 4, 10), mat);
  body.position.y = 0.85 * CELL;
  group.add(body);
  group.userData.body = body;
  group.userData.mat = mat;
  scene.add(group);
  return group;
}

const SURVIVOR_COLOR = 0xd8b878;

export function update3d(world, camYaw) {
  if (!renderer) return;
  const map = world.map;

  // Generators: material reflects state, lit when done
  for (const { g, mesh, light } of genMeshes) {
    mesh.material = g.done ? MAT.genDone : (g.regressing ? MAT.genRegress : MAT.gen);
    light.intensity = g.done ? 6 : 0;
  }

  // Pallets
  for (const { p, board, alongX } of palletMeshes) {
    if (p.state === 'broken') { board.visible = false; continue; }
    board.visible = true;
    if (p.state === 'upright') {
      board.rotation.x = 0;
      board.position.set(p.x, 0.6 * CELL, p.y);
    } else {
      board.rotation.x = -Math.PI / 2;
      board.position.set(p.x, 0.1 * CELL, p.y);
    }
  }

  // Gates + hatch
  for (const { gate, group } of gateGroups) group.visible = !gate.open;
  hatchMesh.visible = map.hatch.open;

  // Survivors
  for (const sv of world.survivors) {
    let mesh = survivorMeshes.get(sv);
    if (!mesh) {
      const color = sv.isBot
        ? parseInt(sv.color.slice(1), 16)
        : SURVIVOR_COLOR;
      mesh = survivorMesh(sv, color);
      survivorMeshes.set(sv, mesh);
    }
    if (sv.health === HEALTH.DEAD) { mesh.visible = false; continue; }
    mesh.visible = true;
    mesh.position.set(sv.x, 0, sv.y);
    mesh.rotation.y = -sv.facing + Math.PI / 2;

    const body = mesh.userData.body;
    if (sv.health === HEALTH.DOWNED) {
      body.rotation.x = Math.PI / 2;
      body.position.y = 0.3 * CELL;
    } else if (sv.health === HEALTH.HOOKED) {
      body.rotation.x = 0;
      body.position.y = 1.5 * CELL; // strung up
    } else if (sv.health === HEALTH.CARRIED) {
      body.rotation.x = Math.PI / 2;
      body.position.y = 1.7 * CELL; // over the shoulder
    } else {
      body.rotation.x = 0;
      body.position.y = sv.stance === STANCE.CROUCH ? 0.55 * CELL : 0.85 * CELL;
    }
    // Injured: darker, bloodier tint
    mesh.userData.mat.color.setHex(
      sv.health === HEALTH.INJURED || sv.health === HEALTH.DOWNED
        ? 0xb0764a
        : (sv.isBot ? parseInt(sv.color.slice(1), 16) : SURVIVOR_COLOR));
  }

  // Killer
  killerGroup.position.set(world.killer.x, 0, world.killer.y);
  killerGroup.rotation.y = -world.killer.facing + Math.PI / 2;

  // Scratch marks
  const marks = world.scratches || [];
  for (let i = 0; i < scratchPool.length; i++) {
    const q = scratchPool[i];
    const m = marks.length - 1 - i >= 0 ? marks[marks.length - 1 - i] : null;
    if (!m) { q.visible = false; continue; }
    q.visible = true;
    q.position.set(m.x, 0.6 + (i % 7) * 0.05, m.y);
    q.material.opacity = 0.55 * (1 - m.age / 10);
  }

  // Third-person camera: behind the player, looking ahead
  const p = world.survivor;
  playerLight.position.set(p.x, 2.2 * CELL, p.y);
  const eyeH = 1.6 * CELL;
  const dist = 3.4 * CELL;
  const fx = Math.cos(camYaw);
  const fz = Math.sin(camYaw);
  camera.position.set(p.x - fx * dist, eyeH + 0.9 * CELL, p.y - fz * dist);
  camera.lookAt(p.x + fx * 1.5 * CELL, eyeH * 0.6, p.y + fz * 1.5 * CELL);

  renderer.render(scene, camera);
}

export function resize3d(w, h) {
  if (!renderer) return;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

// Third-person 3D renderer (three.js/WebGL). The 2D simulation stays
// authoritative: world (x, y) maps to 3D (x, 0, z=y), 1 cell = 1 meter.
// This module only mirrors sim state into meshes; it never mutates it.
//
// Characters are original articulated rigs built from primitives (torso,
// head, limbs with pivot groups) and animated procedurally: walk cycles
// driven by distance traveled, plus state poses (crouch, crawl, carry,
// hook hang) and killer action animations (swing, kick, smash, stagger).

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
let genRigs = [];
let palletMeshes = [];
let gateGroups = [];
let hatchMesh = null;
let survivorRigs = new Map();  // survivor object -> rig
let killerRig = null;
let scratchPool = [];
let playerLight = null;

const MAT = {
  floor: new THREE.MeshStandardMaterial({ color: 0x16161f, roughness: 1 }),
  wall: new THREE.MeshStandardMaterial({ color: 0x3a3450, roughness: 0.9 }),
  window: new THREE.MeshStandardMaterial({ color: 0x46506a, roughness: 0.9 }),
  genBody: new THREE.MeshStandardMaterial({ color: 0x8a7a40, roughness: 0.6, metalness: 0.4 }),
  genDark: new THREE.MeshStandardMaterial({ color: 0x3a3014, roughness: 0.8 }),
  piston: new THREE.MeshStandardMaterial({ color: 0xb8b0a0, roughness: 0.4, metalness: 0.7 }),
  hook: new THREE.MeshStandardMaterial({ color: 0x6a4040, roughness: 0.8 }),
  pallet: new THREE.MeshStandardMaterial({ color: 0x8a6b43, roughness: 1 }),
  gate: new THREE.MeshStandardMaterial({ color: 0x4e6e4e, roughness: 0.9 }),
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

  // Hooks: post, arm, and the hook curve itself
  for (const h of map.hooks) {
    const g = new THREE.Group();
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08 * CELL, 0.11 * CELL, 2.4 * CELL, 7), MAT.hook);
    post.position.y = 1.2 * CELL;
    g.add(post);
    const arm = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05 * CELL, 0.05 * CELL, 0.7 * CELL, 6), MAT.hook);
    arm.rotation.z = Math.PI / 2;
    arm.position.set(0.35 * CELL, 2.3 * CELL, 0);
    g.add(arm);
    const barb = new THREE.Mesh(
      new THREE.TorusGeometry(0.12 * CELL, 0.03 * CELL, 6, 10, Math.PI * 1.2), MAT.hook);
    barb.position.set(0.66 * CELL, 2.2 * CELL, 0);
    g.add(barb);
    g.position.set(h.x, 0, h.y);
    scene.add(g);
  }
}

// --- Rig factory: articulated humanoid from primitives -------------------

function limb(width, length, material) {
  // Pivot group at the joint; the mesh hangs below it
  const pivot = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, length, width), material);
  mesh.position.y = -length / 2;
  pivot.add(mesh);
  return pivot;
}

function makeHumanoid({ skin, cloth, scale = 1, bulk = 1 }) {
  const S = CELL * scale;
  const clothMat = new THREE.MeshStandardMaterial({ color: cloth, roughness: 0.85 });
  const skinMat = new THREE.MeshStandardMaterial({ color: skin, roughness: 0.7 });

  const root = new THREE.Group();   // feet at y=0
  const body = new THREE.Group();   // hip pivot — bobs/leans
  body.position.y = 0.8 * S;
  root.add(body);

  const torso = new THREE.Mesh(
    new THREE.BoxGeometry(0.38 * S * bulk, 0.56 * S, 0.22 * S * bulk), clothMat);
  torso.position.y = 0.28 * S;
  body.add(torso);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.13 * S, 10, 8), skinMat);
  head.position.y = 0.70 * S;
  body.add(head);

  const armL = limb(0.09 * S * bulk, 0.62 * S, clothMat);
  armL.position.set(-0.24 * S * bulk, 0.52 * S, 0);
  body.add(armL);
  const armR = limb(0.09 * S * bulk, 0.62 * S, clothMat);
  armR.position.set(0.24 * S * bulk, 0.52 * S, 0);
  body.add(armR);

  const legL = limb(0.12 * S * bulk, 0.8 * S, clothMat);
  legL.position.set(-0.11 * S, 0, 0);
  body.add(legL);
  const legR = limb(0.12 * S * bulk, 0.8 * S, clothMat);
  legR.position.set(0.11 * S, 0, 0);
  body.add(legR);

  return {
    root, body, head, armL, armR, legL, legR,
    clothMat, skinMat, S,
    phase: 0, lastX: null, lastY: null,
  };
}

function resetPose(rig) {
  rig.root.rotation.set(0, rig.root.rotation.y, 0);
  rig.body.position.y = 0.8 * rig.S;
  rig.body.rotation.set(0, 0, 0);
  rig.armL.rotation.set(0, 0, 0.06);
  rig.armR.rotation.set(0, 0, -0.06);
  rig.legL.rotation.set(0, 0, 0);
  rig.legR.rotation.set(0, 0, 0);
}

// Advance the walk phase by distance traveled so footfalls match speed
function advancePhase(rig, x, y, strideScale = 1) {
  if (rig.lastX !== null) {
    rig.phase += Math.hypot(x - rig.lastX, y - rig.lastY) / (0.55 * CELL) * strideScale;
  }
  rig.lastX = x;
  rig.lastY = y;
}

function poseWalk(rig, amp) {
  const s = Math.sin(rig.phase * Math.PI);
  rig.legL.rotation.x = s * amp;
  rig.legR.rotation.x = -s * amp;
  rig.armL.rotation.x = -s * amp * 0.8;
  rig.armR.rotation.x = s * amp * 0.8;
  rig.body.position.y = 0.8 * rig.S + Math.abs(Math.cos(rig.phase * Math.PI)) * 0.03 * rig.S;
}

function poseCrouch(rig, amp) {
  rig.body.position.y = 0.52 * rig.S;
  rig.body.rotation.x = 0.35;
  const s = Math.sin(rig.phase * Math.PI);
  rig.legL.rotation.x = 0.9 + s * amp * 0.5;
  rig.legR.rotation.x = 0.9 - s * amp * 0.5;
  rig.armL.rotation.x = -0.4;
  rig.armR.rotation.x = -0.4;
}

function poseCrawl(rig, time) {
  // Prone, dragging forward
  rig.root.rotation.x = -Math.PI / 2 + 0.12;
  rig.body.position.y = 0.18 * rig.S;
  const s = Math.sin(time * 4);
  rig.armL.rotation.x = -1.4 + s * 0.5;
  rig.armR.rotation.x = -1.4 - s * 0.5;
  rig.legL.rotation.x = 0.2 + s * 0.2;
  rig.legR.rotation.x = 0.2 - s * 0.2;
}

function poseHang(rig, time) {
  // Strung up: arms above, slow sway
  rig.body.position.y = 1.15 * rig.S;
  rig.root.rotation.z = Math.sin(time * 1.3) * 0.06;
  rig.armL.rotation.set(Math.PI * 0.92, 0, 0.25);
  rig.armR.rotation.set(Math.PI * 0.92, 0, -0.25);
  rig.legL.rotation.x = 0.15;
  rig.legR.rotation.x = -0.1;
  rig.body.rotation.x = 0.15; // slump
}

function poseCarried(rig, time) {
  // Over the killer's shoulder, kicking
  rig.root.rotation.z = Math.PI / 2;
  rig.body.position.y = 0.4 * rig.S;
  const s = Math.sin(time * 9);
  rig.legL.rotation.x = s * 0.7;
  rig.legR.rotation.x = -s * 0.7;
  rig.armL.rotation.x = -0.6 + s * 0.3;
  rig.armR.rotation.x = -0.6 - s * 0.3;
}

function poseRepair(rig, time) {
  // Kneeling at the machine, hands working
  rig.body.position.y = 0.55 * rig.S;
  rig.body.rotation.x = 0.45;
  rig.legL.rotation.x = 1.1;
  rig.legR.rotation.x = 1.1;
  const s = Math.sin(time * 10);
  rig.armL.rotation.x = -1.2 + s * 0.25;
  rig.armR.rotation.x = -1.2 - s * 0.25;
}

// --- Scene construction ---------------------------------------------------

function buildDynamic(map) {
  genRigs = [];
  palletMeshes = [];
  gateGroups = [];
  survivorRigs = new Map();
  scratchPool = [];

  // Generators: engine block with animated pistons and a top lamp
  for (const g of map.generators) {
    const group = new THREE.Group();
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(0.95 * CELL, 0.55 * CELL, 0.8 * CELL), MAT.genBody);
    base.position.y = 0.28 * CELL;
    group.add(base);
    const block = new THREE.Mesh(
      new THREE.BoxGeometry(0.7 * CELL, 0.35 * CELL, 0.55 * CELL), MAT.genDark);
    block.position.y = 0.72 * CELL;
    group.add(block);
    const pistons = [];
    for (const side of [-1, 1]) {
      const p = new THREE.Mesh(
        new THREE.CylinderGeometry(0.07 * CELL, 0.07 * CELL, 0.4 * CELL, 8), MAT.piston);
      p.position.set(side * 0.18 * CELL, 0.95 * CELL, 0);
      group.add(p);
      pistons.push(p);
    }
    const lamp = new THREE.Mesh(
      new THREE.SphereGeometry(0.07 * CELL, 8, 6),
      new THREE.MeshStandardMaterial({ color: 0x332b10, emissive: 0x000000 }));
    lamp.position.set(0, 1.18 * CELL, 0);
    group.add(lamp);
    const light = new THREE.PointLight(0xe8e07a, 0, 5 * CELL);
    light.position.set(0, 1.6 * CELL, 0);
    group.add(light);
    group.position.set(g.x, 0, g.y);
    scene.add(group);
    genRigs.push({ g, group, pistons, lamp, light });
  }

  // Pallets: orientation follows the wall run they plug
  for (const p of map.pallets) {
    const alongX = map.at(p.cx - 1, p.cy) === T.WALL || map.at(p.cx + 1, p.cy) === T.WALL;
    const board = boardPallet();
    if (!alongX) board.rotation.y = Math.PI / 2;
    scene.add(board);
    palletMeshes.push({ p, board, alongX, dropAnim: 0 });
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

  // The Killer: hulking hunched rig with a cleaver and glowing eyes
  killerRig = makeHumanoid({ skin: 0x6a4848, cloth: 0x701822, scale: 1.28, bulk: 1.35 });
  killerRig.body.rotation.x = 0.18; // permanent hunch
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0xffd9a0 });
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(1.5, 6, 6), eyeMat);
    eye.position.set(side * 0.055 * killerRig.S, 0.71 * killerRig.S, 0.1 * killerRig.S);
    killerRig.body.add(eye);
  }
  // Cleaver in the right hand
  const blade = new THREE.Mesh(
    new THREE.BoxGeometry(0.04 * killerRig.S, 0.5 * killerRig.S, 0.16 * killerRig.S),
    new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.3, metalness: 0.8 }));
  blade.position.y = -0.62 * killerRig.S - 0.2 * killerRig.S;
  killerRig.armR.add(blade);
  // Red stain spotlight
  const redStain = new THREE.SpotLight(0xff2030, 14, 7 * CELL, 0.45, 0.6, 1.2);
  redStain.position.set(0, 1.9 * CELL, 0);
  const stainTarget = new THREE.Object3D();
  stainTarget.position.set(0, 0, 4 * CELL);
  killerRig.root.add(stainTarget);
  redStain.target = stainTarget;
  killerRig.root.add(redStain);
  scene.add(killerRig.root);
}

function boardPallet() {
  // A pallet of slats rather than a single board
  const group = new THREE.Group();
  for (let i = 0; i < 4; i++) {
    const slat = new THREE.Mesh(
      new THREE.BoxGeometry(CELL, 0.18 * CELL, 0.1 * CELL), MAT.pallet);
    slat.position.y = (i - 1.5) * 0.26 * CELL;
    group.add(slat);
  }
  for (const side of [-0.4, 0.4]) {
    const rail = new THREE.Mesh(
      new THREE.BoxGeometry(0.1 * CELL, 1.1 * CELL, 0.12 * CELL), MAT.pallet);
    rail.position.x = side * CELL;
    group.add(rail);
  }
  return group;
}

const SURVIVOR_SKIN = 0xd8b878;

// --- Per-frame sync + animation -------------------------------------------

export function update3d(world, camYaw) {
  if (!renderer) return;
  const map = world.map;
  const time = world.time || 0;

  // Generators: pistons pump while crewed, lamp lights when done,
  // red flicker while regressing
  for (const { g, group, pistons, lamp, light } of genRigs) {
    if (!g.done && (g.crew || 0) > 0) {
      pistons.forEach((p, i) => {
        p.position.y = (0.95 + Math.max(0, Math.sin(time * 9 + i * Math.PI)) * 0.18) * CELL;
      });
    }
    if (g.done) {
      lamp.material.emissive.setHex(0xe8e07a);
      lamp.material.emissiveIntensity = 1;
      light.intensity = 6;
    } else if (g.regressing) {
      const flicker = 0.25 + Math.max(0, Math.sin(time * 17)) * 0.5;
      lamp.material.emissive.setHex(0xc03020);
      lamp.material.emissiveIntensity = flicker;
      light.color.setHex(0xc03020);
      light.intensity = flicker * 2;
    } else {
      lamp.material.emissive.setHex(0x000000);
      light.intensity = 0;
    }
  }

  // Pallets: standing slats fall with a quick drop animation
  for (const pm of palletMeshes) {
    const { p, board } = pm;
    if (p.state === 'broken') { board.visible = false; continue; }
    board.visible = true;
    if (p.state === 'upright') {
      pm.dropAnim = 0;
      board.rotation.x = 0;
      board.position.set(p.x, 0.6 * CELL, p.y);
    } else {
      pm.dropAnim = Math.min(1, pm.dropAnim + 0.12);
      const t = pm.dropAnim;
      board.rotation.x = -Math.PI / 2 * (t * t); // accelerating fall
      board.position.set(p.x, (0.6 - 0.5 * t) * CELL, p.y);
    }
  }

  // Gates + hatch
  for (const { gate, group } of gateGroups) group.visible = !gate.open;
  hatchMesh.visible = map.hatch.open;

  // Survivors
  for (const sv of world.survivors) {
    let rig = survivorRigs.get(sv);
    if (!rig) {
      const cloth = sv.isBot ? parseInt(sv.color.slice(1), 16) : 0x4a5a78;
      rig = makeHumanoid({ skin: SURVIVOR_SKIN, cloth, scale: 1 });
      scene.add(rig.root);
      survivorRigs.set(sv, rig);
    }
    if (sv.health === HEALTH.DEAD) { rig.root.visible = false; continue; }
    rig.root.visible = true;
    rig.root.position.set(sv.x, 0, sv.y);
    rig.root.rotation.y = -sv.facing + Math.PI / 2;

    advancePhase(rig, sv.x, sv.y);
    resetPose(rig);

    const repairing = sv === world.survivor
      ? (sv.action && (sv.action.type === 'repair' || sv.action.type === 'heal' ||
                       sv.action.type === 'heal-other' || sv.action.type === 'open-gate'))
      : (sv.goal && (sv.goal.kind === 'repair' || sv.goal.kind === 'heal' ||
                     sv.goal.kind === 'open-gate') && !sv.moving);

    if (sv.health === HEALTH.DOWNED) poseCrawl(rig, time);
    else if (sv.health === HEALTH.HOOKED) poseHang(rig, time);
    else if (sv.health === HEALTH.CARRIED) poseCarried(rig, time);
    else if (repairing) poseRepair(rig, time);
    else if (sv.stance === STANCE.CROUCH) poseCrouch(rig, sv.moving ? 0.6 : 0);
    else if (sv.moving) poseWalk(rig, sv.stance === STANCE.RUN ? 0.85 : 0.5);
    else {
      // Idle breathing
      rig.body.position.y = 0.8 * rig.S + Math.sin(time * 2) * 0.008 * rig.S;
    }

    // Injured: bloodied clothes
    rig.clothMat.color.setHex(
      sv.health === HEALTH.INJURED || sv.health === HEALTH.DOWNED
        ? 0x7a3a2e
        : (sv.isBot ? parseInt(sv.color.slice(1), 16) : 0x4a5a78));
  }

  // Killer rig + action animations
  const k = world.killer;
  killerRig.root.position.set(k.x, 0, k.y);
  killerRig.root.rotation.y = -k.facing + Math.PI / 2;
  advancePhase(killerRig, k.x, k.y, 0.8);
  resetPose(killerRig);
  killerRig.body.rotation.x = 0.18; // keep the hunch

  if (k.lungeTimer > 0) {
    // Swing: cleaver arm whips from wound-up to extended
    const t = 1 - k.lungeTimer / 0.3;
    killerRig.armR.rotation.x = -2.4 + t * 3.2;
    killerRig.body.rotation.x = 0.3;
    poseWalk(killerRig, 0.9);
  } else if (k.state === 'stunned') {
    killerRig.body.rotation.z = Math.sin(time * 10) * 0.18;
    killerRig.body.rotation.x = -0.1;
    killerRig.armL.rotation.x = -1.8; // clutching its face
    killerRig.armR.rotation.x = -1.4;
  } else if (k.state === 'break') {
    // Overhead smash loop
    const t = Math.max(0, Math.sin(time * 5));
    killerRig.armR.rotation.x = -2.6 + t * 3.0;
    killerRig.armL.rotation.x = -0.8;
    killerRig.body.rotation.x = 0.35 + t * 0.1;
  } else if (k.state === 'kick') {
    const t = Math.max(0, Math.sin(time * 6));
    killerRig.legR.rotation.x = -1.1 * t;
    killerRig.body.rotation.x = 0.05;
  } else if (k.state === 'carry') {
    killerRig.armL.rotation.set(Math.PI, 0, -0.5); // steadying the load
    poseWalk(killerRig, 0.5);
  } else if (k.attackCooldown > 1.2) {
    // Weapon wipe after a hit
    killerRig.armR.rotation.x = 0.6;
    killerRig.armL.rotation.x = -0.9;
  } else {
    poseWalk(killerRig, 0.7);
  }

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

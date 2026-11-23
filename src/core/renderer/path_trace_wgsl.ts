// WebGPU 路径追踪烘焙 kernel：每个 workgroup 负责一个 chart 的 8x8 纹素块
// 几何通过 storage buffer 传入（BVH 节点 + 三角形），与 CPU 追踪器共用同一套数据结构
export const PATH_TRACE_WGSL = /* wgsl */ `
struct BvhNode {
  min: vec3<f32>,
  max: vec3<f32>,
  left: i32,
  right: i32,
  firstTri: i32,
  triCount: i32,
}

struct Triangle {
  v0: vec3<f32>,
  v1: vec3<f32>,
  v2: vec3<f32>,
  normal: vec3<f32>,
  objectId: u32,
  surfaceId: u32,
}

struct Light {
  position: vec3<f32>,
  target: vec3<f32>,
  color: vec3<f32>,
  intensity: f32,
  beamAngle: f32,
  length: f32,
  kind: u32,
  castShadow: u32,
}

struct BakeUniforms {
  atlasSize: u32,
  samples: u32,
  bounces: u32,
  lightCount: u32,
  chartX: u32,
  chartY: u32,
  chartW: u32,
  chartH: u32,
  seedBase: u32,
}

@group(0) @binding(0) var<uniform> uniforms: BakeUniforms;
@group(0) @binding(1) var<storage, read> nodes: array<BvhNode>;
@group(0) @binding(2) var<storage, read> tris: array<Triangle>;
@group(0) @binding(3) var<storage, read> lights: array<Light>;
@group(0) @binding(4) var<storage, read> surfacePoints: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read> surfaceNormals: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read_write> outDirect: array<vec4<f32>>;
@group(0) @binding(7) var<storage, read_write> outIndirect: array<vec4<f32>>;
@group(0) @binding(8) var<storage, read_write> outAo: array<vec4<f32>>;

fn lcg(state: ptr<function, u32>) -> f32 {
  *state = (*state * 1664525u + 1013904223u);
  return f32(*state) / 4294967296.0;
}

fn intersectTri(origin: vec3<f32>, dir: vec3<f32>, tri: Triangle, tMax: f32) -> f32 {
  let e1 = tri.v1 - tri.v0;
  let e2 = tri.v2 - tri.v0;
  let h = cross(dir, e2);
  let a = dot(e1, h);
  if (abs(a) < 1e-8) { return -1.0; }
  let f = 1.0 / a;
  let s = origin - tri.v0;
  let u = f * dot(s, h);
  if (u < 0.0 || u > 1.0) { return -1.0; }
  let q = cross(s, e1);
  let v = f * dot(dir, q);
  if (v < 0.0 || u + v > 1.0) { return -1.0; }
  let t = f * dot(e2, q);
  if (t <= 0.002 || t >= tMax) { return -1.0; }
  return t;
}

fn hitAabb(origin: vec3<f32>, invDir: vec3<f32>, node: BvhNode) -> bool {
  var tmin = vec3<f32>(0.0);
  var tmax = vec3<f32>(1e9);
  let lo = (node.min - origin) * invDir;
  let hi = (node.max - origin) * invDir;
  let near = min(lo, hi);
  let far = max(lo, hi);
  tmin = max(tmin, near);
  tmax = min(tmax, far);
  return all(tmax >= tmin);
}

fn trace(origin: vec3<f32>, dir: vec3<f32>) -> vec4<f32> {
  var closest = 1e9;
  var hitTri = -1;
  var stack: array<i32, 32>;
  var sp = 0;
  stack[sp] = 0;
  sp = sp + 1;
  let invDir = 1.0 / (dir + vec3<f32>(1e-9));
  loop {
    if (sp == 0) { break; }
    sp = sp - 1;
    let nodeId = stack[sp];
    let node = nodes[nodeId];
    if (!hitAabb(origin, invDir, node)) { continue; }
    if (node.firstTri >= 0) {
      for (var i = 0; i < node.triCount; i = i + 1) {
        let ti = node.firstTri + i;
        let t = intersectTri(origin, dir, tris[ti], closest);
        if (t > 0.0) {
          closest = t;
          hitTri = ti;
        }
      }
    } else {
      stack[sp] = node.left;
      sp = sp + 1;
      stack[sp] = node.right;
      sp = sp + 1;
    }
  }
  if (hitTri < 0) { return vec4<f32>(-1.0, 0.0, 0.0, 0.0); }
  return vec4<f32>(closest, f32(hitTri), 0.0, 0.0);
}

fn hemisphere(normal: vec3<f32>, state: ptr<function, u32>) -> vec3<f32> {
  let r1 = lcg(state) * 6.2831853;
  let r2 = lcg(state);
  let r = sqrt(r2);
  let helper = select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 1.0, 0.0), abs(normal.y) < 0.9);
  let tangent = normalize(cross(helper, normal));
  let bitangent = cross(normal, tangent);
  let local = vec3<f32>(cos(r1) * r, sqrt(1.0 - r2), sin(r1) * r);
  return normalize(tangent * local.x + normal * local.y + bitangent * local.z);
}

fn directLight(point: vec3<f32>, normal: vec3<f32>, state: ptr<function, u32>) -> vec3<f32> {
  var accum = vec3<f32>(0.0);
  for (var li = 0u; li < uniforms.lightCount; li = li + 1u) {
    let light = lights[li];
    var lp = light.position;
    if (light.kind == 2u) {
      let side = normalize(vec3<f32>(light.target.z - light.position.z, 0.0, light.position.x - light.target.x));
      lp = lp + side * (lcg(state) - 0.5) * light.length;
    }
    let toLight = lp - point;
    let dist = length(toLight);
    let wi = toLight / dist;
    let ndl = dot(normal, wi);
    if (ndl <= 0.0) { continue; }
    let shadow = trace(point + normal * 0.002, wi);
    if (shadow.x > 0.0 && shadow.x < dist - 0.002) { continue; }
    let beam = 1.0;
    let attenuation = 1.0 / (dist * dist + 0.5);
    accum = accum + light.color * light.intensity * attenuation * beam * ndl;
  }
  return accum;
}

fn indirectLight(point: vec3<f32>, normal: vec3<f32>, state: ptr<function, u32>, bounces: u32) -> vec3<f32> {
  if (bounces == 0u) { return vec3<f32>(0.0); }
  let wi = hemisphere(normal, state);
  let hit = trace(point + normal * 0.002, wi);
  if (hit.x < 0.0) { return vec3<f32>(0.0); }
  let tri = tris[i32(hit.y)];
  let nextPoint = point + wi * hit.x;
  let direct = directLight(nextPoint, tri.normal, state);
  let deeper = indirectLight(nextPoint, tri.normal, state, bounces - 1u);
  return (direct + deeper) * dot(wi, normal) * 0.8;
}

fn aoFactor(point: vec3<f32>, normal: vec3<f32>, state: ptr<function, u32>) -> f32 {
  var visible = 0.0;
  for (var i = 0; i < 4; i = i + 1) {
    let dir = hemisphere(normal, state);
    let hit = trace(point + normal * 0.002, dir);
    if (hit.x < 0.0 || hit.x > 1.5) { visible = visible + 1.0; }
  }
  return visible / 4.0;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let px = gid.x;
  let py = gid.y;
  if (px >= uniforms.chartW || py >= uniforms.chartH) { return; }
  var state = uniforms.seedBase + px * 73856093u + py * 19349663u;
  let surfaceIndex = py * uniforms.chartW + px;
  let point = surfacePoints[surfaceIndex].xyz;
  let normal = normalize(surfaceNormals[surfaceIndex].xyz);
  var direct = vec3<f32>(0.0);
  var indirect = vec3<f32>(0.0);
  var ao = 0.0;
  for (var s = 0u; s < uniforms.samples; s = s + 1u) {
    direct = direct + directLight(point, normal, &state);
    indirect = indirect + indirectLight(point, normal, &state, uniforms.bounces);
    ao = ao + aoFactor(point, normal, &state);
  }
  let inv = 1.0 / f32(uniforms.samples);
  let atlasIndex = (uniforms.chartY + py) * uniforms.atlasSize + (uniforms.chartX + px);
  outDirect[atlasIndex] = vec4<f32>(direct * inv, 1.0);
  outIndirect[atlasIndex] = vec4<f32>(indirect * inv, 1.0);
  outAo[atlasIndex] = vec4<f32>(ao * inv, ao * inv, ao * inv, 1.0);
}
`

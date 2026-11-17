struct Scene {
  viewProjection: mat4x4<f32>,
  camera: vec4<f32>,
  sun: vec4<f32>,
  settings: vec4<f32>,
  fog: vec4<f32>,
};
struct Instance {
  positionHeading: vec4<f32>,
  style: vec4<f32>,
  tint: vec4<f32>,
  extra: vec4<f32>,
};
@group(0) @binding(0) var<uniform> scene: Scene;
@group(1) @binding(0) var<storage, read> agents: array<Instance>;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) part: f32,
  @builtin(instance_index) instance: u32,
};
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) normal: vec3<f32>,
  @location(1) color: vec3<f32>,
  @location(2) world: vec3<f32>,
};
fn rotateX(v: vec3<f32>, a: f32) -> vec3<f32> {
  let c = cos(a); let s = sin(a);
  return vec3<f32>(v.x, c * v.y - s * v.z, s * v.y + c * v.z);
}
fn rotateY(v: vec3<f32>, a: f32) -> vec3<f32> {
  let c = cos(a); let s = sin(a);
  return vec3<f32>(c * v.x + s * v.z, v.y, -s * v.x + c * v.z);
}
fn aroundX(v: vec3<f32>, center: vec3<f32>, a: f32) -> vec3<f32> {
  return rotateX(v - center, a) + center;
}

@vertex fn vertexMain(input: VertexInput) -> VertexOutput {
  let agent = agents[input.instance];
  let part = u32(input.part + 0.1);
  let speed = agent.style.y;
  let phase = agent.style.z;
  let appearance = agent.style.w;
  let movement = smoothstep(0.02, 0.55, speed);
  let running = smoothstep(1.9, 3.2, speed);
  let stride = (0.53 + running * 0.31) * movement;
  var p = input.position;
  var n = input.normal;
  let side = select(-1.0, 1.0, part == 4u || part == 6u || part == 8u || part == 10u || part == 12u);
  let cycle = sin(phase + select(0.0, 3.14159265, side > 0.0));
  if (part >= 7u) {
    let hip = vec3<f32>(side * 0.12, 0.91, 0.0);
    let knee = vec3<f32>(side * 0.12, 0.49, 0.0);
    let upperAngle = cycle * stride;
    let lowerAngle = max(0.0, -cycle) * (1.2 + running * 0.8) * movement;
    if (part >= 11u) {
      // Counter-rotate the foot so the supporting sole stays approximately level.
      let ankle = vec3<f32>(side * 0.12, 0.075, 0.0);
      p = aroundX(p, ankle, -upperAngle - lowerAngle);
      n = rotateX(n, -upperAngle - lowerAngle);
    }
    if (part >= 9u) {
      p = aroundX(p, knee, lowerAngle);
      n = rotateX(n, lowerAngle);
    }
    p = aroundX(p, hip, upperAngle);
    n = rotateX(n, upperAngle);
  } else if (part >= 3u && part <= 6u) {
    let shoulder = vec3<f32>(side * 0.29, 1.41, 0.0);
    let elbow = vec3<f32>(side * 0.29, 1.09, 0.0);
    let armAngle = -cycle * stride * 0.76;
    let elbowAngle = -(0.10 + running * 0.8 + max(0.0, cycle) * 0.18) * movement;
    if (part >= 5u) {
      p = aroundX(p, elbow, elbowAngle);
      n = rotateX(n, elbowAngle);
    }
    p = aroundX(p, shoulder, armAngle);
    n = rotateX(n, armAngle);
  }
  // The straight supporting leg determines pelvis height; bent swing legs lift naturally.
  let supportAngle = abs(sin(phase)) * stride;
  p.y -= 0.835 * (1.0 - cos(supportAngle));
  p.y += abs(sin(phase * 2.0)) * 0.012 * movement;
  p.z += (p.y - 0.8) * running * 0.09;
  let width = 0.87 + fract(appearance * 0.618034) * 0.25;
  p.x *= width;
  p *= agent.style.x;
  n.x /= width;
  p = rotateY(p, agent.positionHeading.w) + agent.positionHeading.xyz;
  n = rotateY(n, agent.positionHeading.w);

  let skin = mix(vec3<f32>(0.49, 0.31, 0.21), vec3<f32>(0.91, 0.70, 0.51), fract(appearance * 0.381966));
  let hair = mix(vec3<f32>(0.12, 0.12, 0.10), vec3<f32>(0.47, 0.33, 0.19), fract(appearance * 0.754878));
  var color = agent.tint.rgb;
  if (part == 1u || part == 5u || part == 6u) { color = skin; }
  if (part == 2u) { color = hair; }
  if (part >= 7u) { color = mix(vec3<f32>(0.17, 0.22, 0.23), vec3<f32>(0.44, 0.42, 0.35), fract(appearance * 0.414214)); }
  if (part >= 11u) { color = vec3<f32>(0.16, 0.17, 0.15); }
  if (scene.settings.x > 0.5) {
    color = select(select(vec3<f32>(0.88,0.52,0.23),vec3<f32>(0.31,0.58,0.84),agent.extra.y > 0.5),vec3<f32>(0.48,0.72,0.37),agent.extra.y > 1.5);
  }
  var output: VertexOutput;
  output.position = scene.viewProjection * vec4<f32>(p, 1.0);
  output.normal = normalize(n);
  output.world = p;
  output.color = color;
  return output;
}

@fragment fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
  let diffuse = max(dot(normalize(input.normal), scene.sun.xyz), 0.0);
  let shade = scene.sun.w + (1.0 - scene.sun.w) * diffuse;
  let distance = length(input.world - scene.camera.xyz);
  let fogAmount = smoothstep(scene.settings.w, scene.fog.w, distance) * 0.72;
  return vec4<f32>(mix(input.color * shade, scene.fog.rgb, fogAmount), 1.0);
}

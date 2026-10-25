/**
 * toon.js: shared stylised materials so the pet and the studio read as one
 * coherent look. Cel-shaded MeshToonMaterial with a crisp rim light and an
 * optional glossy "vinyl toy" highlight, plus inverted-hull outlines.
 */
import * as THREE from 'three';

const gradients = new Map();

/** Stepped lighting ramp for MeshToonMaterial (2, 3 or 4 bands). */
export function toonGradient(steps = 3) {
  if (gradients.has(steps)) return gradients.get(steps);
  const values = steps === 4 ? [118, 176, 224, 255] : steps === 2 ? [160, 255] : [132, 208, 255];
  const tex = new THREE.DataTexture(new Uint8Array(values), values.length, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  gradients.set(steps, tex);
  return tex;
}

/**
 * Cel-shaded material. `rim` adds a bright band at grazing angles; `gloss`
 * adds a crisp specular blob from a fixed key light in view space (vinyl look).
 */
export function makeToonMaterial({
  color = '#ffffff', map = null, steps = 3, rim = 0.16, gloss = 0, emissive = null, emissiveIntensity = 1,
  transparent = false, opacity = 1, side = THREE.FrontSide, depthWrite = true, alphaTest = 0,
} = {}) {
  const mat = new THREE.MeshToonMaterial({
    color, map, gradientMap: toonGradient(steps), transparent, opacity, side, depthWrite, alphaTest,
  });
  if (emissive) {
    mat.emissive = new THREE.Color(emissive);
    mat.emissiveIntensity = emissiveIntensity;
  }
  if (rim > 0 || gloss > 0) {
    const uniforms = { uRim: { value: rim }, uGloss: { value: gloss } };
    mat.userData.toonUniforms = uniforms;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uRim;\nuniform float uGloss;')
        .replace('#include <opaque_fragment>', `
          {
            vec3 V = normalize( vViewPosition );
            float ndv = clamp( dot( normal, V ), 0.0, 1.0 );
            float rimBand = smoothstep( 0.6, 0.76, 1.0 - ndv );
            outgoingLight += mix( diffuseColor.rgb, vec3( 1.0 ), 0.6 ) * rimBand * uRim;
            vec3 L = normalize( vec3( -0.45, 0.8, 0.6 ) );
            float sp = pow( clamp( dot( normal, normalize( L + V ) ), 0.0, 1.0 ), 60.0 );
            outgoingLight += vec3( 1.0 ) * smoothstep( 0.42, 0.52, sp ) * uGloss;
          }
          #include <opaque_fragment>`);
    };
    mat.customProgramCacheKey = () => 'petstudio-toon-rim-gloss-v1';
  }
  return mat;
}

const outlineCache = new Map();

/** Solid back-face material pushed out along normals (inverted-hull outline). */
export function outlineMaterial(color = '#3d2838', thickness = 0.016) {
  const key = `${color}|${thickness}`;
  if (outlineCache.has(key)) return outlineCache.get(key);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uThickness: { value: thickness } },
    vertexShader: /* glsl */ `
      uniform float uThickness;
      void main() {
        vec3 p = position + normalize( normal ) * uThickness;
        gl_Position = projectionMatrix * modelViewMatrix * vec4( p, 1.0 );
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      void main() {
        gl_FragColor = vec4( uColor, 1.0 );
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide,
  });
  outlineCache.set(key, mat);
  return mat;
}

/** Adds an outline child to `mesh` (never pickable, never casts shadows). */
export function addOutline(mesh, { color, thickness } = {}) {
  const outline = new THREE.Mesh(mesh.geometry, outlineMaterial(color, thickness));
  outline.name = `${mesh.name || 'mesh'}:outline`;
  outline.raycast = () => {};
  outline.castShadow = false;
  outline.receiveShadow = false;
  outline.userData.isOutline = true;
  mesh.add(outline);
  return outline;
}

/** Hex colour helpers. */
export function shadeHex(hex, amount) {
  const c = new THREE.Color(hex);
  const hsl = {};
  c.getHSL(hsl, THREE.SRGBColorSpace);
  c.setHSL(hsl.h, hsl.s, Math.min(1, Math.max(0, hsl.l + amount)), THREE.SRGBColorSpace);
  return `#${c.getHexString()}`;
}

export function hexToRgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

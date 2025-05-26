const cache = new WeakMap();

export function isWebGL2(gl) {
  if (cache.has(gl)) {
    return cache.get(gl);
  } else {
    const version = gl.getParameter(gl.VERSION);
    const value = version ? version.startsWith("WebGL 2.0") : false;
    cache.set(gl, value);
    return value;
  }
  return false; // NOTE make lint happy.
}

export function getShaderVersion(source) {
  let version = 100;
  const words = source.match(/[^\s]+/g);
  if (words && words.length >= 2 && words[0] === "#version") {
    const v = parseInt(words[1], 10);
    if (Number.isFinite(v)) {
      version = v;
    }
  }
  return version;
}

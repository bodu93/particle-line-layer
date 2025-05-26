/*
 * Copyright (c) 2021-2023 WeatherLayers.com
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */
import { LineLayer } from "@deck.gl/layers";
import { BufferTransform as Transform } from "@luma.gl/engine";
import {
  isViewportGlobe,
  getViewportGlobeCenter,
  getViewportGlobeRadius,
  getViewportBounds,
} from "./utils/viewport.js";
import updateTransformVs from "./particle-layer-update-transform.vs.glsl";

const FPS = 25;

const DEFAULT_COLOR = [255, 255, 255, 255];

const defaultProps = {
  ...LineLayer.defaultProps,

  image: { type: "image", value: null, async: true },
  imageUnscale: { type: "array", value: null },

  numParticles: { type: "number", min: 1, max: 1000000, value: 5000 },
  maxAge: { type: "number", min: 1, max: 255, value: 100 },
  speedFactor: { type: "number", min: 0, max: 2, value: 1 },

  color: { type: "color", value: DEFAULT_COLOR },
  width: { type: "number", value: 1 },
  animate: true,

  bounds: { type: "array", value: [-180, -90, 180, 90], compare: true },
  wrapLongitude: true,
};

export default class ParticleLayer extends LineLayer {
  getShaders() {
    return {
      ...super.getShaders(),
      inject: {
        "vs:#decl": `
          out float drop;
          const vec2 DROP_POSITION = vec2(0);
        `,
        "vs:#main-start": `
          drop = float(instanceSourcePositions.xy == DROP_POSITION || instanceTargetPositions.xy == DROP_POSITION);
        `,
        "fs:#decl": `
          in float drop;
        `,
        "fs:#main-start": `
          if (drop > 0.5) discard;
        `,
      },
    };
  }

  initializeState() {
    super.initializeState({});
    this._setupTransformFeedback();
    const attributeManager = this.getAttributeManager();
    attributeManager.remove([
      "instanceSourcePositions",
      "instanceTargetPositions",
      "instanceColors",
      "instanceWidhts",
    ]);
    attributeManager.addInstanced({
      instanceSourcePositions: {
        size: 3,
        type: "float32",
        noAlloc: true,
      },
      instanceTargetPositions: {
        size: 3,
        type: "float32",
        noAlloc: true,
      },
      instanceColors: {
        size: 4,
        type: "float32",
        noAlloc: true,
      },
      instanceWidths: {
        size: 1,
        type: "float32",
        noAlloc: true,
      },
    });
  }

  updateState({ props, oldProps, changeFlags }) {
    const { numParticles, maxAge, color, width } = props;

    super.updateState({ props, oldProps, changeFlags });

    if (!numParticles || !maxAge || !width) {
      this._deleteTransformFeedback();
      return;
    }

    if (
      numParticles !== oldProps.numParticles ||
      maxAge !== oldProps.maxAge ||
      color[0] !== oldProps.color[0] ||
      color[1] !== oldProps.color[1] ||
      color[2] !== oldProps.color[2] ||
      color[3] !== oldProps.color[3] ||
      width !== oldProps.width
    ) {
      this._setupTransformFeedback();
    }
  }

  finalizeState() {
    this._deleteTransformFeedback();

    super.finalizeState();
  }

  draw({ uniforms }) {
    const { device } = this.context;
    const { initialized } = this.state;
    if (!initialized) {
      return;
    }

    const { animate } = this.props;
    const {
      sourcePositions,
      targetPositions,
      colors,
      sourcePositions64Low,
      targetPositions64Low,
      widths,
      model,
    } = this.state;

    // // DEBUG ONLY!
    // const LENGTH = 3 * 3 * 10;
    // const s = sourcePositions.readSyncWebGL(0, LENGTH);
    // console.log(
    //   "sourcePositions",
    //   new Float32Array(s.buffer, s.byteOffset, s.byteLength / 4)
    // );
    // const t = targetPositions.readSyncWebGL(0, LENGTH);
    // console.log(
    //   "targetPositions",
    //   new Float32Array(t.buffer, t.byteOffset, t.byteLength / 4)
    // );
    // const c = colors.readSyncWebGL(0, LENGTH);
    // console.log(
    //   "colors",
    //   new Float32Array(c.buffer, c.byteOffset, c.byteLength / 4)
    // );

    model.setConstantAttributes({
      instanceSourcePositions64Low: sourcePositions64Low,
      instanceTargetPositions64Low: targetPositions64Low,
      instanceWidths: widths,
    });
    model.setAttributes({
      instanceSourcePositions: sourcePositions,
      instanceTargetPositions: targetPositions,
      instanceColors: colors,
    });

    model.setParameters({
      ...model.parameters,
      cullMode: "front",
      depthCompare: "always",
    });
    super.draw({ uniforms });

    if (animate) {
      this.requestStep();
    }
  }

  _setupTransformFeedback() {
    const { device } = this.context;
    const { initialized } = this.state;
    if (initialized) {
      this._deleteTransformFeedback();
    }

    const { numParticles, maxAge, color, width } = this.props;

    // sourcePositions/targetPositions buffer layout:
    // |          age0         |          age1         |          age2         |...|          ageN         |
    // |pos1,pos2,pos3,...,posN|pos1,pos2,pos3,...,posN|pos1,pos2,pos3,...,posN|...|pos1,pos2,pos3,...,posN|
    const numInstances = numParticles * maxAge;
    const numAgedInstances = numParticles * (maxAge - 1);
    const sourcePositions = device.createBuffer({
      data: new Float32Array(numInstances * 3),
      usage: 0x08 | 0x20,
    });
    const targetPositions = device.createBuffer({
      data: new Float32Array(numInstances * 3),
      usage: 0x04 | 0x20,
    });
    const sourcePositions64Low = new Float32Array([0, 0, 0]); // constant attribute
    const targetPositions64Low = new Float32Array([0, 0, 0]); // constant attribute
    const c = new Array(numInstances)
      .fill(undefined)
      .map((_, i) => {
        const age = Math.floor(i / numParticles);
        return [
          color[0],
          color[1],
          color[2],
          (color[3] ?? 255) * (1 - age / maxAge),
        ].map((d) => d / 255);
      })
      .flat();
    const colors = device.createBuffer(new Float32Array(c));
    const widths = new Float32Array([width]); // constant attribute

    const transform = new Transform(device, {
      vs: updateTransformVs,
      vertexCount: numInstances,
      attributes: {
        ["sourcePosition"]: sourcePositions,
      },
      bufferLayout: [
        {
          name: "sourcePosition",
          format: "float32x3",
        },
        {
          name: "targetPosition",
          format: "float32x3",
        },
      ],
      feedbackBuffers: {
        ["targetPosition"]: targetPositions,
      },
      varyings: ["targetPosition"],
    });

    this.setState({
      initialized: true,
      numInstances,
      numAgedInstances,
      sourcePositions,
      targetPositions,
      sourcePositions64Low,
      targetPositions64Low,
      colors,
      widths,
      transform,
    });
  }

  _runTransformFeedback() {
    const { initialized } = this.state;
    if (!initialized) {
      return;
    }

    const { device, viewport, timeline } = this.context;
    const { image, imageUnscale, bounds, numParticles, speedFactor, maxAge } =
      this.props;
    const {
      numAgedInstances,
      sourcePositions,
      targetPositions,
      transform,
      previousViewportZoom,
      previousTime,
    } = this.state;
    const time = timeline.getTime();
    if (!image || time === previousTime) {
      return;
    }

    // viewport
    const viewportGlobe = isViewportGlobe(viewport);
    const viewportGlobeCenter = getViewportGlobeCenter(viewport);
    const viewportGlobeRadius = getViewportGlobeRadius(viewport);
    const viewportBounds = getViewportBounds(viewport);
    const viewportZoomChangeFactor =
      2 ** ((previousViewportZoom - viewport.zoom) * 4);

    // speed factor for current zoom level
    const currentSpeedFactor = speedFactor / 2 ** (viewport.zoom + 7);

    // update particles age0
    const uniforms = {
      viewportGlobe,
      viewportGlobeCenter: viewportGlobeCenter || [0, 0],
      viewportGlobeRadius: viewportGlobeRadius || 0,
      viewportBounds: viewportBounds || [0, 0, 0, 0],
      viewportZoomChangeFactor: viewportZoomChangeFactor || 0,

      imageUnscale: imageUnscale || [0, 0],
      bounds,
      numParticles,
      maxAge,
      speedFactor: currentSpeedFactor,

      time,
      seed: Math.random(),
    };

    transform.model.setUniforms(uniforms);
    transform.model.setBindings({ bitmapTexture: image });

    transform.run({
      clearColor: false,
      clearDepth: false,
      clearStencil: false,
      depthReadOnly: true,
      stencilReadOnly: true,
    });

    /// update particles age1-age(N-1)
    /// copy age0-age(N-2) sourcePositions to age1-age(N-1) targetPositions
    const commandEncoder = device.createCommandEncoder();
    commandEncoder.copyBufferToBuffer({
      source: targetPositions,
      sourceOffset: 0,
      destination: sourcePositions,
      destinationOffset: numParticles * 4 * 3,
      size: numAgedInstances * 4 * 3,
    });
    commandEncoder.finish();
    commandEncoder.destroy();

    // swap
    this.state.sourcePositions = targetPositions;
    this.state.targetPositions = sourcePositions;
    transform.model.setAttributes({
      ["sourcePosition"]: targetPositions,
    });
    transform.transformFeedback.setBuffers({
      ["targetPosition"]: sourcePositions,
    });

    this.state.previousViewportZoom = viewport.zoom;
    this.state.previousTime = time;
  }

  _resetTransformFeedback() {
    const { initialized } = this.state;
    if (!initialized) {
      return;
    }

    const { numInstances, sourcePositions, targetPositions } = this.state;

    sourcePositions.write(new Float32Array(numInstances * 3));
    targetPositions.write(new Float32Array(numInstances * 3));
  }

  _deleteTransformFeedback() {
    const { initialized } = this.state;
    if (!initialized) {
      return;
    }

    const { sourcePositions, targetPositions, colors, transform } = this.state;

    sourcePositions.delete();
    targetPositions.delete();
    colors.delete();
    transform.delete();

    this.setState({
      initialized: false,
      sourcePositions: undefined,
      targetPositions: undefined,
      sourcePositions64Low: undefined,
      targetPositions64Low: undefined,
      colors: undefined,
      widths: undefined,
      transform: undefined,
    });
  }

  requestStep() {
    const { stepRequested } = this.state;
    if (stepRequested) {
      return;
    }

    this.state.stepRequested = true;
    setTimeout(() => {
      this.step();
      this.state.stepRequested = false;
    }, 1000 / FPS);
  }

  step() {
    this._runTransformFeedback();

    this.setNeedsRedraw();
  }

  clear() {
    this._resetTransformFeedback();

    this.setNeedsRedraw();
  }
}

ParticleLayer.layerName = "ParticleLayer";
ParticleLayer.defaultProps = defaultProps;

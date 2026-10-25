// I1 studio bridge, integrated from the four-lane CONSOLIDATED bundle
// (original supplier blob e31e5979c37ea1acc472ad02e444ba6c928be15b, only the import seam
// relocated per SOURCE-LEDGER.json bundleBridgeModification — here to PRODUCT paths, not
// raw implementations, so the single integrated Round 8 factory + Round 9 holdout gate are
// the only copies in the runtime. No duplicate registry, controller, sender or learner journal.)
import { synthesizeWebappAdapter, shadowEvaluateAdapter } from './adaptive-adapter-factory.mjs';
import { assertIndependentAdapterHoldout } from './adapter-holdout-gate.mjs';
import { createAdapterImprovementPipeline } from './adapter-improvement-pipeline.mjs';
export function createStudioAdapterLearner({ verifyCapture, store }) {
  return createAdapterImprovementPipeline({ synthesize: synthesizeWebappAdapter, shadowEvaluate: shadowEvaluateAdapter,
    assertIndependentHoldout: assertIndependentAdapterHoldout, verifyCapture, store });
}

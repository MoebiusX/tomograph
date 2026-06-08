// studio/focus.mjs
//
// Pack focus (A | B). The Conformance / Compile / Schema views render a
// single pack at a time; when both A and B are loaded the user flips focus
// between them via the toggle in the view nav. effectiveFocus() falls back
// to 'a' if focus is 'b' but Pack B isn't loaded — defensive, since the
// toggle is hidden in that state anyway. These read/write `state` only; the
// orchestration action setViewFocus() (which re-renders) stays in app.mjs.

import { state } from './state.mjs';

export function effectiveFocus() {
  return (state.viewFocus === 'b' && state.packB) ? 'b' : 'a';
}
export function focusedPackId()   { return effectiveFocus() === 'b' ? state.compareBId  : state.selectedPackId; }
export function focusedEnv()      { return effectiveFocus() === 'b' ? state.compareBEnv : state.selectedEnv; }
export function focusedPack()     { return effectiveFocus() === 'b' ? state.packB       : state.pack; }

export function focusedConformance()     { return effectiveFocus() === 'b' ? state.conformanceB     : state.conformance; }
export function setFocusedConformance(v) { if (effectiveFocus() === 'b') state.conformanceB = v; else state.conformance = v; }

export function focusedCompileCatalog()     { return effectiveFocus() === 'b' ? state.compileCatalogB     : state.compileCatalog; }
export function setFocusedCompileCatalog(v) { if (effectiveFocus() === 'b') state.compileCatalogB = v; else state.compileCatalog = v; }
export function focusedCompileContent()     { return effectiveFocus() === 'b' ? state.compileContentB     : state.compileContent; }
export function setFocusedCompileContent(v) { if (effectiveFocus() === 'b') state.compileContentB = v; else state.compileContent = v; }
export function focusedCompileGroup()       { return effectiveFocus() === 'b' ? state.compileGroupB       : state.compileGroup; }
export function setFocusedCompileGroup(v)   { if (effectiveFocus() === 'b') state.compileGroupB = v; else state.compileGroup = v; }
export function focusedCompileFlavor()      { return effectiveFocus() === 'b' ? state.compileFlavorB      : state.compileFlavor; }
export function setFocusedCompileFlavor(v)  { if (effectiveFocus() === 'b') state.compileFlavorB = v; else state.compileFlavor = v; }
export function focusedCompileArtifact()    { return effectiveFocus() === 'b' ? state.compileArtifactB    : state.compileArtifact; }
export function setFocusedCompileArtifact(v){ if (effectiveFocus() === 'b') state.compileArtifactB = v; else state.compileArtifact = v; }

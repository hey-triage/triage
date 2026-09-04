/**
 * Fast mode, as the UI describes it.
 *
 * The wire values are the SDK's own; only the copy lives here. Two facts stay
 * apart on purpose: what the user asked for, and what the subprocess reports
 * it can actually do. A toggle that silently does nothing is worse than no
 * toggle, so every reason the SDK can give for refusing has a sentence here.
 */
import type { FastModeDisabledReason, ModelOption } from '../../shared/protocol.js'
import { findModel } from './models.js'

/** One line, wherever fast mode is offered. */
export const FAST_MODE_BLURB = 'Same model, up to ~2.5× faster output, at premium pricing.'

const REASON: Record<FastModeDisabledReason, string> = {
  free: 'it needs a paid plan',
  preference: 'it is turned off in your Claude settings',
  extra_usage_disabled: 'extra usage is disabled on your account',
  network_error: "Anthropic couldn't be reached to check availability",
  unknown: 'your account cannot use it right now',
  not_first_party: 'it only works against the Anthropic API directly',
  disabled_by_env: 'it is disabled in this environment',
  model_not_allowed: "this model is not in your organization's allowed models",
  sdk_opt_in_required: 'this build of Claude Code does not offer it to the SDK',
  pending: 'availability is still being checked',
}

/** Why fast mode is not serving, in a sentence. Unknown reasons read as plain. */
export const fastModeReason = (r: FastModeDisabledReason | undefined): string =>
  (r && REASON[r]) || 'it is unavailable here'

/**
 * Whether the model a session runs on can do fast mode at all. Unknown counts
 * as yes: the catalog may not have loaded, and refusing a toggle on a guess
 * would be a worse lie than letting the server say no.
 */
export function modelSupportsFastMode(models: ModelOption[], model: string | undefined): boolean {
  const row = findModel(models, model)
  return row ? row.supportsFastMode === true : true
}

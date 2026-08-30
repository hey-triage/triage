/**
 * The model catalog, as the server probed it from Claude Code itself.
 *
 * One fetch per page load, shared by every picker: the list is a property of
 * the machine, not of a composer. A failed probe resolves to an empty list —
 * the picker then simply has nothing to offer, which is the honest rendering
 * of "we could not ask".
 */
import { useEffect, useState } from 'react'
import type { EffortLevel, ModelOption, ModelsResponse } from '../../shared/protocol.js'

let inFlight: Promise<ModelOption[]> | null = null

export function loadModels(): Promise<ModelOption[]> {
  inFlight ??= fetch('/api/models')
    .then((r) => r.json() as Promise<ModelsResponse>)
    .then((b) => (b.ok ? b.models : []))
    .catch(() => [])
  return inFlight
}

export function useModels(): ModelOption[] {
  const [models, setModels] = useState<ModelOption[]>([])
  useEffect(() => {
    let live = true
    void loadModels().then((m) => {
      if (live) setModels(m)
    })
    return () => {
      live = false
    }
  }, [])
  return models
}

/**
 * The row a model string belongs to. An exact id wins over an alias that
 * merely resolves to it, so an explicit pick of `sonnet` highlights Sonnet
 * rather than the Default row that happens to point at the same wire model.
 */
export function findModel(models: ModelOption[], id: string | undefined): ModelOption | undefined {
  if (!id) return undefined
  return models.find((m) => m.id === id) ?? models.find((m) => m.resolvedModel === id)
}

export const EFFORT_LABEL: Record<EffortLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
}

/** A stored effort string is only usable if it is still a level we know. */
export const isEffort = (v: unknown): v is EffortLevel => typeof v === 'string' && v in EFFORT_LABEL

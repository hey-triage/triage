/**
 * Shared bits for the Watches surfaces: connector labels and icons, and the
 * schedule presets the form and the table both speak.
 */
import { GitBranch, Globe, Hash, Layers, type LucideProps } from 'lucide-react'
import type { ComponentType } from 'react'
import type { WatchConnector, WatchOutput } from '../../shared/protocol.js'

export const CONNECTORS: Array<{ id: WatchConnector; label: string; icon: ComponentType<LucideProps> }> = [
  { id: 'web', label: 'Web', icon: Globe },
  { id: 'slack', label: 'Slack', icon: Hash },
  { id: 'linear', label: 'Linear', icon: Layers },
  { id: 'github', label: 'GitHub', icon: GitBranch },
]

export const connectorLabel = (id: WatchConnector): string => CONNECTORS.find((c) => c.id === id)?.label ?? id

/** The schedule presets — a preset plus a local time renders to one cron line. */
export type SchedulePreset = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'custom'

export const PRESETS: Array<{ id: SchedulePreset; label: string }> = [
  { id: 'hourly', label: 'Hourly' },
  { id: 'daily', label: 'Daily' },
  { id: 'weekdays', label: 'Weekdays' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'custom', label: 'Custom' },
]

export function presetToCron(preset: Exclude<SchedulePreset, 'custom'>, time: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time)
  const h = m ? Math.min(23, Number(m[1])) : 9
  const min = m ? Math.min(59, Number(m[2])) : 0
  if (preset === 'hourly') return `${min} * * * *`
  if (preset === 'daily') return `${min} ${h} * * *`
  if (preset === 'weekdays') return `${min} ${h} * * 1-5`
  return `${min} ${h} * * 1`
}

/** Recognise a cron line as one of the presets (with its time), else custom. */
export function cronToPreset(cron: string): { preset: SchedulePreset; time: string } {
  const pad = (n: string) => n.padStart(2, '0')
  let m = /^(\d+) \* \* \* \*$/.exec(cron)
  if (m) return { preset: 'hourly', time: `09:${pad(m[1])}` }
  m = /^(\d+) (\d+) \* \* (\*|1-5|1)$/.exec(cron)
  if (m) {
    const time = `${pad(m[2])}:${pad(m[1])}`
    return { preset: m[3] === '*' ? 'daily' : m[3] === '1-5' ? 'weekdays' : 'weekly', time }
  }
  return { preset: 'custom', time: '09:00' }
}

/** What a run produces. */
export const OUTPUTS: Array<{ id: WatchOutput; label: string; hint: string }> = [
  { id: 'items', label: 'Work items', hint: 'One item per match, deduped by its link.' },
  { id: 'digest', label: 'Digest', hint: 'One rolling item with a markdown report. Each run rewrites it and it returns to the inbox.' },
]

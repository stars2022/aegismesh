export type AvatarMotion = 'idle' | 'greet' | 'explain' | 'applaud'
export type AvatarClips = Partial<Record<AvatarMotion, string>>
export type AvatarMotionState = {
  greeting: boolean
  speaking: boolean
  busy: boolean
  visible: boolean
  reducedMotion: boolean
  saveData: boolean
  paused?: boolean
}

// Add only locally stored, reviewed video assets here. Missing clips keep the portrait.
export const avatarClips: AvatarClips = {
  idle: '/media/digital-human-idle.mp4',
  greet: '/media/digital-human-greet.mp4',
  explain: '/media/digital-human-talk.mp4',
}

/** Applause is deliberately never selected automatically for an arbitrary answer. */
export function selectAvatarMotion(state: AvatarMotionState, clips: AvatarClips,
  failed: ReadonlySet<AvatarMotion> = new Set()): AvatarMotion | null {
  if (!state.visible || state.reducedMotion || state.saveData || state.paused) return null
  const available = (motion: AvatarMotion) => !!clips[motion] && !failed.has(motion)
  if (state.speaking && available('explain')) return 'explain'
  if (state.greeting && !state.speaking && !state.busy && available('greet')) return 'greet'
  return available('idle') ? 'idle' : null
}

export function avatarMotionLoops(motion: AvatarMotion) {
  return motion === 'idle' || motion === 'explain'
}

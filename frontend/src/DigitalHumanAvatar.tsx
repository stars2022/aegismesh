import { useEffect, useRef, useState } from 'react'
import { Pause, Play } from 'lucide-react'
import { avatarClips, avatarMotionLoops, selectAvatarMotion, type AvatarMotion } from './avatarMotion'

type ConnectionPreferences = EventTarget & { saveData?: boolean }

/** Decorative, muted motion only. Speech stays in the existing local voice player. */
export function DigitalHumanAvatar({ speaking, busy, consultationId }: {
  speaking: boolean; busy: boolean; consultationId: string
}) {
  const stage = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const [greeted, setGreeted] = useState<string | null>(null)
  const [visible, setVisible] = useState(false)
  const [reducedMotion, setReducedMotion] = useState(true)
  const [saveData, setSaveData] = useState(false)
  const [paused, setPaused] = useState(false)
  const [failed, setFailed] = useState<Set<AvatarMotion>>(() => new Set())
  const [playing, setPlaying] = useState<string | null>(null)
  const motion = selectAvatarMotion({ greeting: greeted !== consultationId, speaking, busy,
    visible, reducedMotion, saveData, paused }, avatarClips, failed)
  const playbackKey = motion === 'greet' ? `${motion}:${consultationId}` : motion

  useEffect(() => {
    const preference = matchMedia('(prefers-reduced-motion: reduce)')
    const connection = (navigator as Navigator & { connection?: ConnectionPreferences }).connection
    let intersecting = !('IntersectionObserver' in window)
    const refreshVisibility = () => setVisible(!document.hidden && intersecting)
    const refreshPreferences = () => {
      setReducedMotion(preference.matches)
      setSaveData(!!connection?.saveData)
    }
    const observer = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
      intersecting = entries.some(entry => entry.isIntersecting)
      refreshVisibility()
    }, { threshold: 0 }) : null
    if (stage.current) observer?.observe(stage.current)
    refreshPreferences(); refreshVisibility()
    preference.addEventListener('change', refreshPreferences)
    connection?.addEventListener('change', refreshPreferences)
    document.addEventListener('visibilitychange', refreshVisibility)
    return () => {
      observer?.disconnect()
      preference.removeEventListener('change', refreshPreferences)
      connection?.removeEventListener('change', refreshPreferences)
      document.removeEventListener('visibilitychange', refreshVisibility)
    }
  }, [])

  // Do not play a delayed welcome after the user has already started a question.
  useEffect(() => { if (speaking || busy) setGreeted(consultationId) }, [speaking, busy, consultationId])

  useEffect(() => {
    const element = video.current
    setPlaying(null)
    if (!element || !motion) return
    let active = true
    element.muted = true
    const unavailable = () => { if (active) setFailed(current => new Set(current).add(motion)) }
    const timeout = window.setTimeout(() => { if (element.readyState < 2) unavailable() }, 12_000)
    void element.play().catch(unavailable)
    return () => { active = false; window.clearTimeout(timeout); element.pause() }
  }, [motion, playbackKey])

  const fail = () => { if (motion) setFailed(current => new Set(current).add(motion)) }
  return <div ref={stage} className={`dh-host-stage${motion && playing === playbackKey ? ' has-motion' : ''}`}>
    <img className="dh-avatar-poster" src="/media/digital-human-matte-poster.jpg" alt="佩戴 AegisMesh 名牌的虚拟助手麦溪"/>
    {motion && <video key={playbackKey} ref={video} className="dh-avatar-video" src={avatarClips[motion]}
      muted playsInline loop={avatarMotionLoops(motion)} preload="none" aria-hidden="true"
      disablePictureInPicture disableRemotePlayback tabIndex={-1}
      onPlaying={() => setPlaying(playbackKey)} onError={fail}
      onEnded={() => { setPlaying(null); if (motion === 'greet') setGreeted(consultationId) }}/>
    }
    {!reducedMotion && !saveData && (motion || paused) && <button type="button" className="dh-motion-toggle"
      aria-label={paused ? '播放数字人动作' : '暂停数字人动作'} onClick={() => setPaused(value => !value)}>
      {paused ? <Play size={14}/> : <Pause size={14}/>} {paused ? '播放动作' : '暂停动作'}
    </button>}
  </div>
}

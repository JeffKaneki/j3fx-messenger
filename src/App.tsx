import { ChangeEvent, FormEvent, PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { invokeWithFreshSession, supabase } from './lib/supabase'
import { App as NativeApp } from '@capacitor/app'
import { Browser } from '@capacitor/browser'
import { Capacitor } from '@capacitor/core'
import { PushNotifications } from '@capacitor/push-notifications'
import appIcon from './assets/app icon.jpg'
import videoCallIcon from './assets/video call.png'
import voiceCallIcon from './assets/voice call.png'
import { PeerCall } from './components/PeerCall'

type Profile = { id: string; username: string; display_name: string; avatar_url: string | null; last_seen_at?: string; theme?: string }
type Conversation = { id: string; title: string | null; is_group: boolean; updated_at: string; other: Profile; nickname?: string | null }
type Message = { id: string; conversation_id: string; sender_id: string; body: string; client_id: string; created_at: string; status: string; edited_at?: string | null; deleted_at?: string | null }
type Reaction = { message_id: string; user_id: string; reaction: string }
type QueueItem = { clientId: string; conversationId: string; body: string }
type Attachment = { id: string; message_id: string; mime_type: string; byte_size: number; storage_path: string }
type Receipt = { message_id: string; user_id: string; delivered_at: string | null; read_at: string | null }
type CallType = 'audio' | 'video'
type CallSession = { id: string; conversation_id: string; caller_id: string; callee_id: string; call_type: CallType; status: string; created_at: string; expires_at: string }
type CallHistoryEntry = { id: string; conversation_id: string; caller_id: string; callee_id: string; call_type: CallType; status: string; created_at: string; accepted_at: string | null; ended_at: string | null }
type ActiveCall = { id: string; conversationId: string; role: 'caller' | 'callee'; callType: CallType; peerName: string }

const queueKey = 'j3fx-message-outbox'

function initials(name: string) { return name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase() }
function formatTime(value: string) { return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(value)) }
function formatCallDuration(startedAt: string | null, endedAt: string | null) {
  if (!startedAt || !endedAt) return ''
  const seconds = Math.max(0, Math.floor((Date.parse(endedAt) - Date.parse(startedAt)) / 1000))
  if (seconds < 60) return `${seconds} sec${seconds === 1 ? '' : 's'}`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return remainingSeconds >= 30 ? `${minutes + 1} min${minutes === 0 ? '' : 's'}` : `${minutes} min${minutes === 1 ? '' : 's'}`
}
function isOnline(lastSeen?: string) { return Boolean(lastSeen && Date.now() - Date.parse(lastSeen) < 120000) }
function presenceText(lastSeen?: string) { return isOnline(lastSeen) ? 'Online now' : lastSeen ? `Last seen ${formatTime(lastSeen)}` : 'Offline' }
function readQueue(): QueueItem[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(queueKey) ?? '[]')
    return Array.isArray(value) && value.every((item) => typeof item?.clientId === 'string' && typeof item?.conversationId === 'string' && typeof item?.body === 'string') ? value as QueueItem[] : []
  } catch {
    return []
  }
}
function readMutedConversations(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem('j3fx-muted-conversations') ?? '[]')
    return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : []
  } catch {
    return []
  }
}
function AttachIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m20.5 11.5-8.8 8.8a5 5 0 0 1-7.1-7.1l9.2-9.2a3.5 3.5 0 0 1 5 5l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
}
function SendIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21 3-7.2 18-3.5-7.3L3 10.2 21 3Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /><path d="M10.3 13.7 21 3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
}
function BackIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6M9 12h12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
}
async function getCallFunctionError(error: { message: string; context?: unknown }) {
  if (error.context instanceof Response) {
    let message = ''
    try {
      const payload: unknown = await error.context.json()
      if (payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string') message = payload.error
      else if (payload && typeof payload === 'object' && 'message' in payload && typeof payload.message === 'string') message = payload.message
    } catch {
      message = ''
    }
    return message
      ? `Call service (${error.context.status}): ${message}`
      : `Call service returned HTTP ${error.context.status}. Check that the function is deployed and configured.`
  }
  return error.message
}
export default function App() {
  const [session, setSession] = useState<{ user: { id: string; email?: string } } | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState('')
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [loadingConversations, setLoadingConversations] = useState(false)
  const [hasMoreConversations, setHasMoreConversations] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [messagesLoadError, setMessagesLoadError] = useState<{ conversationId: string; message: string } | null>(null)
  const [messageSendError, setMessageSendError] = useState<{ conversationId: string; message: string } | null>(null)
  const [composer, setComposer] = useState('')
  const [outbox, setOutbox] = useState<QueueItem[]>(readQueue)
  const [search, setSearch] = useState('')
  const [conversationFilter, setConversationFilter] = useState<'all' | 'groups'>('all')
  const [peopleSearch, setPeopleSearch] = useState('')
  const [people, setPeople] = useState<Profile[]>([])
  const [messageSearch, setMessageSearch] = useState('')
  const [searchingMessages, setSearchingMessages] = useState(false)
  const [showDetails, setShowDetails] = useState(true)
  const [detailsSection, setDetailsSection] = useState<string | null>(null)
  const [mutedConversationIds, setMutedConversationIds] = useState<string[]>(readMutedConversations)
  const [theme, setTheme] = useState(() => {
    const stored = localStorage.getItem('j3fx-theme')
    return stored === 'night' ? 'dark' : stored ?? 'mist'
  })
  const [newUsername, setNewUsername] = useState('')
  const [showNewConversation, setShowNewConversation] = useState(false)
  const [newConversationMode, setNewConversationMode] = useState<'direct' | 'group'>('direct')
  const [groupTitle, setGroupTitle] = useState('')
  const [reactions, setReactions] = useState<Reaction[]>([])
  const [hasOlderMessages, setHasOlderMessages] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [receipts, setReceipts] = useState<Receipt[]>([])
  const [profileFile, setProfileFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [profileAvatarUrl, setProfileAvatarUrl] = useState<string | null>(null)
  const [attachmentUrls, setAttachmentUrls] = useState<Record<string, string>>({})
  const [incomingCall, setIncomingCall] = useState<CallSession | null>(null)
  const [callHistory, setCallHistory] = useState<CallHistoryEntry[]>([])
  const [pendingIncomingCallId, setPendingIncomingCallId] = useState<string | null>(null)
  const [pendingNotificationConversationId, setPendingNotificationConversationId] = useState<string | null>(null)
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null)
  const [callError, setCallError] = useState('')
  const [ringSoundBlocked, setRingSoundBlocked] = useState(false)
  const [startingCall, setStartingCall] = useState(false)
  const [joiningCallId, setJoiningCallId] = useState<string | null>(null)
  const dismissedCallIdRef = useRef<string | null>(null)
  const ringtoneContextRef = useRef<AudioContext | null>(null)
  const ringtoneAudioRef = useRef<HTMLAudioElement | null>(null)
  const pushTokenRef = useRef<string | null>(null)
  const [cropSource, setCropSource] = useState<string | null>(null)
  const [cropZoom, setCropZoom] = useState(1)
  const [cropOffset, setCropOffset] = useState({ x: 0, y: 0 })
  const cropDragRef = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const messageListRef = useRef<HTMLDivElement>(null)
  const conversationListRef = useRef<HTMLDivElement>(null)
  const messageSearchRef = useRef<HTMLInputElement>(null)
  const scrollLatestPendingRef = useRef(false)
  const suppressLatestScrollRef = useRef(false)

  useEffect(() => {
    if (!supabase) return
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: listener } = supabase.auth.onAuthStateChange((_event, next) => setSession(next))
    return () => listener.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (Capacitor.getPlatform() !== 'android') return
    let disposed = false
    let actionListener: { remove: () => Promise<void> } | null = null
    void PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
      if (disposed) return
      const data: unknown = action.notification.data
      if (!data || typeof data !== 'object') return
      const notificationData = data as Record<string, unknown>
      if (notificationData.type === 'incoming_call' && typeof notificationData.callId === 'string') {
        setPendingIncomingCallId(notificationData.callId)
      } else if (notificationData.type === 'message' && typeof notificationData.conversationId === 'string') {
        setPendingNotificationConversationId(notificationData.conversationId)
      }
    }).then((listener) => {
      if (disposed) void listener.remove()
      else actionListener = listener
    }).catch((listenerError: unknown) => {
      console.error('Push notification action listener failed:', listenerError)
    })
    return () => {
      disposed = true
      if (actionListener) void actionListener.remove()
    }
  }, [])

  useEffect(() => {
    const client = supabase
    if (!client || !session || Capacitor.getPlatform() !== 'android') return
    let disposed = false
    const listeners: Array<{ remove: () => Promise<void> }> = []

    const registerPushNotifications = async () => {
      await Promise.all([
        PushNotifications.createChannel({
          id: 'incoming_calls',
          name: 'Incoming calls',
          description: 'Incoming J3FX voice and video calls',
          importance: 5,
          visibility: 1,
          sound: 'incoming_call',
          vibration: true,
        }),
        PushNotifications.createChannel({
          id: 'messages',
          name: 'Messages',
          description: 'New J3FX messages',
          importance: 3,
          vibration: true,
        }),
      ])

      listeners.push(await PushNotifications.addListener('registration', async ({ value }) => {
        if (disposed) return
        pushTokenRef.current = value
        const { error: tokenError } = await client.from('push_devices').upsert({
          user_id: session.user.id,
          token: value,
          platform: 'android',
          updated_at: new Date().toISOString(),
        }, { onConflict: 'token' })
        if (tokenError) {
          console.error('Push token registration failed:', tokenError.message)
          setCallError(`Push registration failed: ${tokenError.message}`)
        }
      }))
      listeners.push(await PushNotifications.addListener('registrationError', (registrationError) => {
        console.error('Android push registration failed:', registrationError)
        setCallError('Android push registration failed. Check Google Play services and Firebase setup.')
      }))

      const currentPermission = await PushNotifications.checkPermissions()
      const permission = currentPermission.receive === 'granted'
        ? currentPermission
        : await PushNotifications.requestPermissions()
      if (permission.receive !== 'granted') {
        setCallError('Notifications are disabled. Allow them in Android settings to receive calls and messages while away.')
        return
      }
      await PushNotifications.register()
    }

    void registerPushNotifications().catch((registrationError: unknown) => {
      console.error('Android push setup failed:', registrationError)
      setCallError('Could not set up Android push notifications. Check the Firebase configuration and try again.')
    })
    return () => {
      disposed = true
      for (const listener of listeners) void listener.remove()
    }
  }, [session?.user.id])

  useEffect(() => {
    const client = supabase
    const userId = session?.user.id
    if (!client || !userId || !pendingIncomingCallId) return
    let disposed = false
    void client.from('call_sessions')
      .select('id,conversation_id,caller_id,callee_id,call_type,status,created_at,expires_at')
      .eq('id', pendingIncomingCallId)
      .eq('callee_id', userId)
      .eq('status', 'ringing')
      .gt('expires_at', new Date().toISOString())
      .maybeSingle()
      .then(({ data, error: lookupError }) => {
        if (disposed) return
        if (lookupError) {
          setCallError(`Unable to open this call invitation: ${lookupError.message}`)
        } else if (data) {
          setIncomingCall(data as CallSession)
        } else {
          setCallError('This call invitation has expired or is no longer available.')
        }
        setPendingIncomingCallId(null)
      })
    return () => { disposed = true }
  }, [session?.user.id, pendingIncomingCallId])

  useEffect(() => {
    if (!session?.user.id || !pendingNotificationConversationId) return
    setSelectedId(pendingNotificationConversationId)
    setPendingNotificationConversationId(null)
  }, [session?.user.id, pendingNotificationConversationId])

  useEffect(() => {
    const client = supabase
    if (!client || !session) return
    const channel = client.channel(`call-sessions:${session.user.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'call_sessions', filter: `callee_id=eq.${session.user.id}` }, (payload) => {
        const call = payload.new as CallSession
        if (call.id !== dismissedCallIdRef.current && call.status === 'ringing' && Date.parse(call.expires_at) > Date.now()) {
          setIncomingCall(call)
        }
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'call_sessions', filter: `callee_id=eq.${session.user.id}` }, (payload) => {
        const call = payload.new as CallSession
        if (call.status !== 'ringing') {
          setIncomingCall((current) => current?.id === call.id ? null : current)
        }
      })
      .subscribe((status) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.warn('Call invitation realtime is unavailable; polling fallback remains active.')
        }
      })
    const pollIncomingCalls = async () => {
      if (activeCall) return
      const { data, error: queryError } = await client
        .from('call_sessions')
        .select('id,conversation_id,caller_id,callee_id,call_type,status,created_at,expires_at')
        .eq('callee_id', session.user.id)
        .eq('status', 'ringing')
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (queryError) {
        setCallError(`Unable to check incoming calls: ${queryError.message}`)
        return
      }
      if (data && data.id !== dismissedCallIdRef.current) {
        setIncomingCall((current) => current ?? data as CallSession)
      }
    }
    void pollIncomingCalls()
    const fallback = window.setInterval(() => { void pollIncomingCalls() }, 4000)
    return () => {
      window.clearInterval(fallback)
      void client.removeChannel(channel)
    }
  }, [session?.user.id, activeCall?.id])

  useEffect(() => {
    if (!incomingCall) return
    const expiresIn = Math.max(0, Date.parse(incomingCall.expires_at) - Date.now())
    const timeout = window.setTimeout(() => {
      void closeCall(incomingCall.id, true)
    }, expiresIn)
    return () => window.clearTimeout(timeout)
  }, [incomingCall?.id, incomingCall?.expires_at])

  useEffect(() => {
    if (!incomingCall || activeCall) {
      setRingSoundBlocked(false)
      return
    }
    let stopped = false
    let interval: number | null = null
    let fallbackStarted = false
    let context: AudioContext | null = null
    let contextStateListener: (() => void) | null = null
    const audio = new Audio(new URL('ringtone.mp3', document.baseURI).href)
    audio.loop = true
    audio.preload = 'auto'
    audio.volume = 0.8
    ringtoneAudioRef.current = audio

    const startFallbackTone = async () => {
      if (stopped || fallbackStarted) return
      fallbackStarted = true
      console.info('Custom ringtone is unavailable; using the built-in tone.')
      if (!window.AudioContext) {
        setRingSoundBlocked(true)
        return
      }

      context = new AudioContext()
      ringtoneContextRef.current = context
      const activeContext = context
      const playTone = (frequency: number, startAt: number) => {
        const oscillator = activeContext.createOscillator()
        const gain = activeContext.createGain()
        oscillator.type = 'sine'
        oscillator.frequency.setValueAtTime(frequency, startAt)
        gain.gain.setValueAtTime(0.0001, startAt)
        gain.gain.exponentialRampToValueAtTime(0.14, startAt + 0.04)
        gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.42)
        oscillator.connect(gain)
        gain.connect(activeContext.destination)
        oscillator.start(startAt)
        oscillator.stop(startAt + 0.43)
        oscillator.addEventListener('ended', () => {
          oscillator.disconnect()
          gain.disconnect()
        }, { once: true })
      }
      const playRing = () => {
        if (stopped || activeContext.state !== 'running') return
        const startAt = activeContext.currentTime
        playTone(440, startAt)
        playTone(480, startAt + 0.45)
      }
      const updatePlaybackState = () => {
        if (!stopped) setRingSoundBlocked(activeContext.state !== 'running')
      }
      contextStateListener = updatePlaybackState
      activeContext.addEventListener('statechange', contextStateListener)
      try {
        await activeContext.resume()
        if (stopped) return
        updatePlaybackState()
        playRing()
        interval = window.setInterval(playRing, 2600)
      } catch (ringError) {
        console.warn('Incoming call ringtone could not start until sound is enabled:', ringError)
        updatePlaybackState()
      }
    }
    const handleAudioError = () => { void startFallbackTone() }
    audio.addEventListener('error', handleAudioError)

    const startRinging = async () => {
      try {
        await audio.play()
        if (!stopped) setRingSoundBlocked(false)
      } catch (ringError) {
        if (stopped) return
        if (ringError instanceof DOMException && ringError.name === 'NotAllowedError') {
          setRingSoundBlocked(true)
        } else {
          void startFallbackTone()
        }
      }
    }
    void startRinging()
    return () => {
      stopped = true
      if (interval !== null) window.clearInterval(interval)
      audio.removeEventListener('error', handleAudioError)
      audio.pause()
      audio.src = ''
      if (ringtoneAudioRef.current === audio) ringtoneAudioRef.current = null
      if (context) {
        if (contextStateListener) context.removeEventListener('statechange', contextStateListener)
        if (ringtoneContextRef.current === context) ringtoneContextRef.current = null
        void context.close()
      }
    }
  }, [incomingCall?.id, activeCall?.id])

  async function enableIncomingRingtone() {
    const audio = ringtoneAudioRef.current
    if (audio) {
      try {
        await audio.play()
        setRingSoundBlocked(false)
        return
      } catch (ringError) {
        if (!(ringError instanceof DOMException && ringError.name === 'NotAllowedError')) {
          console.warn('Could not play the custom ringtone:', ringError)
        }
      }
    }
    const context = ringtoneContextRef.current
    if (!context) {
      setRingSoundBlocked(true)
      return
    }
    try {
      await context.resume()
      setRingSoundBlocked(context.state !== 'running')
    } catch (soundError) {
      console.warn('Could not enable incoming call ringtone:', soundError)
      setRingSoundBlocked(true)
    }
  }

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return
    let disposed = false
    let listener: { remove: () => Promise<void> } | undefined
    void NativeApp.addListener('backButton', ({ canGoBack }) => {
      if (selectedId) setSelectedId(null)
      else if (canGoBack) window.history.back()
      else void NativeApp.exitApp()
    }).then((handle) => {
      if (disposed) void handle.remove()
      else listener = handle
    })
    return () => {
      disposed = true
      void listener?.remove()
    }
  }, [selectedId])

  useEffect(() => {
    const client = supabase
    if (!Capacitor.isNativePlatform() || !client) return
    let disposed = false
    let listener: { remove: () => Promise<void> } | undefined
    void NativeApp.addListener('appUrlOpen', async ({ url }) => {
      const callback = new URL(url)
      const hash = new URLSearchParams(callback.hash.slice(1))
      const code = callback.searchParams.get('code')
      if (code) {
        const { error: authError } = await client.auth.exchangeCodeForSession(code)
        if (authError) setError(authError.message)
        return
      }
      const accessToken = hash.get('access_token')
      const refreshToken = hash.get('refresh_token')
      if (accessToken && refreshToken) {
        const { error: authError } = await client.auth.setSession({ access_token: accessToken, refresh_token: refreshToken })
        if (authError) setError(authError.message)
      }
    }).then((handle) => {
      if (disposed) void handle.remove()
      else listener = handle
    })
    return () => {
      disposed = true
      void listener?.remove()
    }
  }, [])

  useEffect(() => {
    const client = supabase
    if (!client || !session) { setProfile(null); return }
    client.from('profiles').select('id,username,display_name,avatar_url,last_seen_at,theme').eq('id', session.user.id).single()
      .then(async ({ data, error: queryError }) => {
        if (queryError) { setError(queryError.message); return }
        setProfile(data)
        if (data?.avatar_url) {
          const { data: signed } = await client.storage.from('profile-media').createSignedUrl(data.avatar_url, 300)
          setProfileAvatarUrl(signed?.signedUrl ?? null)
        }
      })
  }, [session])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('j3fx-theme', theme)
  }, [theme])

  useEffect(() => {
    if (!supabase || !session) return
    const tick = () => void supabase?.rpc('touch_presence')
    tick()
    const timer = window.setInterval(tick, 30000)
    return () => window.clearInterval(timer)
  }, [session])

  useEffect(() => {
    const client = supabase
    const term = peopleSearch.trim()
    if (!client || !session || term.length < 2) { setPeople([]); return }
    const timer = window.setTimeout(async () => {
      const { data, error: peopleError } = await client.from('profiles').select('id,username,display_name,avatar_url,last_seen_at,theme').neq('id', session.user.id).or(`display_name.ilike.%${term}%,username.ilike.%${term}%`).limit(8)
      if (peopleError) setError(peopleError.message); else setPeople(data ?? [])
    }, 250)
    return () => window.clearTimeout(timer)
  }, [peopleSearch, session])

  async function loadConversations(loadMore = false) {
    const client = supabase
    if (!client || !session || loadingConversations) return
    setLoadingConversations(true)
    const offset = loadMore ? conversations.length : 0
    const { data, error: queryError } = await client.from('conversation_members')
      .select('conversation_id, nickname, conversations!inner(id,title,is_group,updated_at)')
      .eq('user_id', session.user.id).order('updated_at', { foreignTable: 'conversations', ascending: false }).range(offset, offset + 9)
    if (queryError) { setError(queryError.message); setLoadingConversations(false); return }
    const ids = (data ?? []).map((row) => row.conversation_id)
    const { data: members } = ids.length ? await client.from('conversation_members').select('conversation_id,profiles!inner(id,username,display_name,avatar_url,last_seen_at,theme)').in('conversation_id', ids).neq('user_id', session.user.id) : { data: [] }
    const resolvedMembers = await Promise.all((members ?? []).map(async (row) => {
      const member = row.profiles as unknown as Profile
      if (!member.avatar_url) return [row.conversation_id, member] as const
      const { data: signed } = await client.storage.from('profile-media').createSignedUrl(member.avatar_url, 300, { transform: { width: 96, height: 96, resize: 'cover', quality: 70 } })
      return [row.conversation_id, { ...member, avatar_url: signed?.signedUrl ?? null }] as const
    }))
    const otherByConversation = new Map(resolvedMembers)
    const next = (data ?? []).map((row) => ({ ...(row.conversations as unknown as Omit<Conversation, 'other' | 'nickname'>), nickname: row.nickname, other: otherByConversation.get(row.conversation_id)! })).filter((row) => row.other)
    setHasMoreConversations((data ?? []).length === 10)
    setConversations((current) => loadMore ? [...current, ...next] : next)
    setLoadingConversations(false)
  }

  useEffect(() => {
    if (!session) {
      setConversations([])
      setHasMoreConversations(false)
      return
    }
    void loadConversations()
  }, [session])

  function handleConversationScroll() {
    const list = conversationListRef.current
    if (!list || !hasMoreConversations || loadingConversations) return
    if (list.scrollHeight - list.scrollTop - list.clientHeight < 120) void loadConversations(true)
  }

  useEffect(() => {
    const client = supabase
    if (!client || !session) return
    const channel = client.channel('inbox-updates')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, () => { void loadConversations() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversation_members' }, () => { void loadConversations() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, () => { void loadConversations() })
      .subscribe()
    const fallback = window.setInterval(() => { void loadConversations() }, 5000)
    return () => { window.clearInterval(fallback); void client.removeChannel(channel) }
  }, [session])

  async function loadMessages(conversationId: string, before?: string) {
    const client = supabase
    if (!client) return
    let query = client.from('messages').select('*').eq('conversation_id', conversationId).order('created_at', { ascending: false }).limit(51)
    if (before) query = query.lt('created_at', before)
    const { data, error: queryError } = await query
    if (queryError) {
      setMessagesLoadError({ conversationId, message: queryError.message })
      return
    }
    setMessagesLoadError((current) => current?.conversationId === conversationId ? null : current)
    const page = (data ?? []).slice(0, 50).reverse()
    setHasOlderMessages((data ?? []).length > 50)
    setMessages((current) => before ? [...page, ...current] : page)
    if (session) {
      void Promise.all(page.filter((message) => message.sender_id !== session.user.id).map((message) => client.rpc('mark_message_delivered', { target_message: message.id })))
    }

    const messageIds = page.map((message) => message.id)
    const [reactionResult, attachmentResult, receiptResult] = await Promise.all([
      client.from('message_reactions').select('message_id,user_id,reaction').in('message_id', messageIds),
      client.from('message_attachments').select('*').in('message_id', messageIds),
      client.from('message_receipts').select('*').in('message_id', messageIds),
    ])
    const { data: reactionData, error: reactionError } = reactionResult
    if (reactionError) setError(reactionError.message)
    else setReactions((current) => {
      const loadedIds = new Set(page.map((message) => message.id))
      return [...current.filter((reaction) => !loadedIds.has(reaction.message_id)), ...(reactionData ?? [])]
    })
    const { data: attachmentData, error: attachmentError } = attachmentResult
    if (attachmentError) setError(attachmentError.message)
    else {
      const nextAttachments = attachmentData ?? []
      setAttachments((current) => [...current.filter((item) => !page.some((message) => message.id === item.message_id)), ...nextAttachments])
      const imageAttachments = nextAttachments.filter((attachment) => attachment.mime_type.startsWith('image/'))
      void Promise.all(imageAttachments.map((attachment) => loadAttachmentUrl(attachment)))
    }
    const { data: receiptData, error: receiptError } = receiptResult
    if (receiptError) setError(receiptError.message)
    else setReceipts((current) => [...current.filter((receipt) => !page.some((message) => message.id === receipt.message_id)), ...(receiptData ?? [])])
  }

  useEffect(() => {
    const client = supabase
    if (!client || !selectedId) {
      setCallHistory([])
      return
    }
    let disposed = false
    setCallHistory([])
    const loadCallHistory = async () => {
      const { data, error: historyError } = await client
        .from('call_sessions')
        .select('id,conversation_id,caller_id,callee_id,call_type,status,created_at,accepted_at,ended_at')
        .eq('conversation_id', selectedId)
        .in('status', ['declined', 'missed', 'ended'])
        .order('created_at', { ascending: true })
        .limit(100)
      if (disposed) return
      if (historyError) {
        setError(`Unable to load call history: ${historyError.message}`)
        return
      }
      setCallHistory((data ?? []) as CallHistoryEntry[])
    }
    void loadCallHistory()
    const channel = client.channel(`call-history:${selectedId}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'call_sessions',
        filter: `conversation_id=eq.${selectedId}`,
      }, () => { void loadCallHistory() })
      .subscribe()
    return () => {
      disposed = true
      void client.removeChannel(channel)
    }
  }, [selectedId])

  async function loadOlderMessages() {
    if (!selectedId || !messages.length || loadingOlder) return
    suppressLatestScrollRef.current = true
    setLoadingOlder(true)
    await loadMessages(selectedId, messages[0].created_at)
    setLoadingOlder(false)
    requestAnimationFrame(() => { suppressLatestScrollRef.current = false })
  }

  async function syncCurrentConversation() {
    if (!selectedId) return
    await loadMessages(selectedId)
    await loadConversations()
  }

  useEffect(() => {
    const client = supabase
    if (!client || !selectedId) return
    setMessages([])
    setReactions([])
    setReceipts([])
    scrollLatestPendingRef.current = true
    suppressLatestScrollRef.current = false
    void loadMessages(selectedId)
    void markRead(selectedId)
    const channel = client.channel(`conversation:${selectedId}`, { config: { private: false } })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages', filter: `conversation_id=eq.${selectedId}` }, (payload) => {
        if (payload.eventType === 'INSERT') {
          scrollLatestPendingRef.current = true
          setMessages((current) => current.some((message) => message.id === payload.new.id) ? current : [...current, payload.new as Message])
        }
        if (payload.eventType === 'UPDATE') setMessages((current) => current.map((message) => message.id === payload.new.id ? payload.new as Message : message))
        if (payload.eventType !== 'INSERT') void syncCurrentConversation()
      }).on('postgres_changes', { event: '*', schema: 'public', table: 'message_reactions' }, (payload) => {
        if (payload.eventType === 'INSERT') setReactions((current) => [...current, payload.new as Reaction])
        if (payload.eventType === 'DELETE') setReactions((current) => current.filter((reaction) => !(reaction.message_id === payload.old.message_id && reaction.user_id === payload.old.user_id && reaction.reaction === payload.old.reaction)))
      }).on('postgres_changes', { event: '*', schema: 'public', table: 'message_receipts' }, () => { void loadMessages(selectedId) })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'message_attachments' }, () => { void syncCurrentConversation() })
      .subscribe((status) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setError('Realtime unavailable; synchronization fallback is active.')
      })
    const fallback = window.setInterval(() => { void syncCurrentConversation() }, 5000)
    return () => { window.clearInterval(fallback); void client.removeChannel(channel) }
  }, [selectedId])

  useEffect(() => {
    if ((!messages.length && !outbox.length) || !scrollLatestPendingRef.current || suppressLatestScrollRef.current) return
    const scrollToLatest = () => {
      const list = messageListRef.current
      if (list) list.scrollTop = list.scrollHeight
    }
    requestAnimationFrame(() => {
      scrollToLatest()
      requestAnimationFrame(() => {
        scrollToLatest()
        scrollLatestPendingRef.current = false
      })
    })
  }, [messages.length, selectedId, attachments.length, outbox.length])

  useEffect(() => {
    if (!selectedId || !messages.length) return
    const scrollToLatest = () => {
      if (!suppressLatestScrollRef.current && messageListRef.current) {
        messageListRef.current.scrollTop = messageListRef.current.scrollHeight
      }
    }
    const frame = requestAnimationFrame(scrollToLatest)
    const firstTimer = window.setTimeout(scrollToLatest, 80)
    const secondTimer = window.setTimeout(scrollToLatest, 350)
    const finalTimer = window.setTimeout(scrollToLatest, 900)
    return () => {
      cancelAnimationFrame(frame)
      window.clearTimeout(firstTimer)
      window.clearTimeout(secondTimer)
      window.clearTimeout(finalTimer)
    }
  }, [selectedId])

  async function toggleReaction(messageId: string) {
    if (!supabase || !session) return
    const existing = reactions.find((reaction) => reaction.message_id === messageId && reaction.user_id === session.user.id && reaction.reaction === 'heart')
    const result = existing
      ? await supabase.from('message_reactions').delete().match({ message_id: messageId, user_id: session.user.id, reaction: 'heart' })
      : await supabase.from('message_reactions').insert({ message_id: messageId, user_id: session.user.id, reaction: 'heart' })
    if (result.error) setError(result.error.message)
    else await loadMessages(selectedId!)
  }

  async function editMessage(message: Message) {
    if (!supabase) return
    const body = window.prompt('Edit message', message.body)?.trim()
    if (!body || body === message.body) return
    const { error: editError } = await supabase.from('messages').update({ body, edited_at: new Date().toISOString() }).eq('id', message.id)
    if (editError) setError(editError.message)
  }

  async function deleteMessage(message: Message) {
    if (!supabase || !window.confirm('Delete this message for everyone?')) return
    const { error: deleteError } = await supabase.from('messages').update({ body: 'Message deleted', deleted_at: new Date().toISOString() }).eq('id', message.id)
    if (deleteError) setError(deleteError.message)
  }

  async function markRead(conversationId: string) {
    if (!supabase || !session) return
    const { error: readError } = await supabase.rpc('mark_conversation_read', { target_conversation: conversationId })
    if (readError) setError(readError.message)
  }

  async function searchMessages(event?: FormEvent) {
    event?.preventDefault()
    if (!supabase || !selectedId || !messageSearch.trim()) return
    setSearchingMessages(true)
    const { data, error: searchError } = await supabase.from('messages').select('*').eq('conversation_id', selectedId).ilike('body', `%${messageSearch.trim()}%`).order('created_at', { ascending: true }).limit(100)
    if (searchError) setMessagesLoadError({ conversationId: selectedId, message: searchError.message })
    else {
      setMessagesLoadError((current) => current?.conversationId === selectedId ? null : current)
      setMessages(data ?? [])
    }
    setSearchingMessages(false)
  }

  async function choosePerson(person: Profile) {
    setNewUsername(person.username)
    setPeopleSearch('')
    setPeople([])
    setShowNewConversation(true)
    setNewConversationMode('direct')
  }

  function selectProfilePhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/') || file.size > 5 * 1024 * 1024) { setError('Profile photos must be images up to 5 MB.'); return }
    setProfileFile(file)
    setCropZoom(1)
    setCropOffset({ x: 0, y: 0 })
    setCropSource(URL.createObjectURL(file))
  }

  function handleCropPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId)
    cropDragRef.current = { x: event.clientX, y: event.clientY, offsetX: cropOffset.x, offsetY: cropOffset.y }
  }

  function handleCropPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = cropDragRef.current
    if (!drag) return
    setCropOffset({ x: drag.offsetX + event.clientX - drag.x, y: drag.offsetY + event.clientY - drag.y })
  }

  function handleCropPointerUp() {
    cropDragRef.current = null
  }

  async function uploadProfilePhoto() {
    if (!supabase || !session || !profileFile) return
    const image = new Image()
    image.src = cropSource ?? URL.createObjectURL(profileFile)
    await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('Unable to read image')) })
    const viewportSize = 320
    const baseScale = Math.min(viewportSize / image.naturalWidth, viewportSize / image.naturalHeight)
    const scale = baseScale * cropZoom
    const renderedWidth = image.naturalWidth * scale
    const renderedHeight = image.naturalHeight * scale
    const left = (viewportSize - renderedWidth) / 2 + cropOffset.x
    const top = (viewportSize - renderedHeight) / 2 + cropOffset.y
    const sourceX = Math.max(0, Math.min(image.naturalWidth - viewportSize / scale, -left / scale))
    const sourceY = Math.max(0, Math.min(image.naturalHeight - viewportSize / scale, -top / scale))
    const sourceSize = Math.min(image.naturalWidth, image.naturalHeight, viewportSize / scale)
    const canvas = document.createElement('canvas')
    canvas.width = 512; canvas.height = 512
    canvas.getContext('2d')?.drawImage(image, sourceX, sourceY, sourceSize, sourceSize, 0, 0, 512, 512)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88))
    if (!blob) { setError('Unable to crop image.'); return }
    const path = `${session.user.id}/${crypto.randomUUID()}.jpg`
    const { error: uploadError } = await supabase.storage.from('profile-media').upload(path, blob, { contentType: 'image/jpeg' })
    if (uploadError) { setError(uploadError.message); return }
    const { error: updateError } = await supabase.from('profiles').update({ avatar_url: path }).eq('id', session.user.id)
    if (updateError) setError(updateError.message)
    else {
      const { data: signed } = await supabase.storage.from('profile-media').createSignedUrl(path, 300)
      setProfileAvatarUrl(signed?.signedUrl ?? null)
      setProfile((current) => current ? { ...current, avatar_url: path } : current)
    }
    if (cropSource) URL.revokeObjectURL(cropSource)
    setCropSource(null)
    setProfileFile(null)
    setCropZoom(1)
    setCropOffset({ x: 0, y: 0 })
  }

  async function openAttachment(attachment: Attachment) {
    if (!supabase) return
    const { data, error: urlError } = await supabase.storage.from('message-media').createSignedUrl(attachment.storage_path, 120)
    if (urlError || !data) { setError(urlError?.message ?? 'Unable to open attachment.'); return }
    if (attachment.mime_type.startsWith('image/')) setPreviewUrl(data.signedUrl)
    else await openExternalUrl(data.signedUrl)
  }

  async function loadAttachmentUrl(attachment: Attachment, attempt = 0) {
    if (!supabase) return
    const { data, error } = await supabase.storage.from('message-media').createSignedUrl(attachment.storage_path, 300, { transform: { width: 720, height: 520, resize: 'contain', quality: 78 } })
    if (data?.signedUrl) {
      setAttachmentUrls((current) => ({ ...current, [attachment.id]: data.signedUrl }))
      return
    }
    if (attempt < 2) {
      window.setTimeout(() => void loadAttachmentUrl(attachment, attempt + 1), 400 * (attempt + 1))
      return
    }
    if (error) {
      const fallback = await supabase.storage.from('message-media').createSignedUrl(attachment.storage_path, 300)
      if (fallback.data?.signedUrl) setAttachmentUrls((current) => ({ ...current, [attachment.id]: fallback.data.signedUrl }))
    }
  }

  async function blockOtherUser() {
    if (!supabase || !selected || selected.is_group || !window.confirm(`Block @${selected.other.username}?`)) return
    const { error: blockError } = await supabase.from('user_blocks').insert({ blocker_id: session?.user.id, blocked_id: selected.other.id })
    if (blockError) setError(blockError.message)
    else { setError('User blocked.'); setSelectedId(null) }
  }

  async function reportOtherUser() {
    if (!supabase || !selected || selected.is_group) return
    const reason = window.prompt('Why are you reporting this account?')?.trim()
    if (!reason) return
    const { error: reportError } = await supabase.from('user_reports').insert({ reporter_id: session?.user.id, reported_id: selected.other.id, reason })
    if (reportError) setError(reportError.message); else setError('Report submitted.')
  }

  async function leaveSelectedConversation() {
    if (!supabase || !selected || !window.confirm('Leave this conversation?')) return
    const { error: leaveError } = await supabase.rpc('leave_conversation', { target_conversation: selected.id })
    if (leaveError) setError(leaveError.message)
    else { setSelectedId(null); await loadConversations() }
  }

  async function changeNickname() {
    if (!supabase || !selected) return
    const nickname = window.prompt('Nickname for this conversation', selected.nickname ?? '')?.trim()
    if (nickname === undefined) return
    const { error: nicknameError } = await supabase.from('conversation_members').update({ nickname: nickname || null }).eq('conversation_id', selected.id).eq('user_id', session?.user.id)
    if (nicknameError) setError(nicknameError.message)
    else setConversations((current) => current.map((item) => item.id === selected.id ? { ...item, nickname: nickname || null } : item))
  }

  function toggleMute() {
    if (!selected) return
    const next = mutedConversationIds.includes(selected.id)
      ? mutedConversationIds.filter((id) => id !== selected.id)
      : [...mutedConversationIds, selected.id]
    setMutedConversationIds(next)
    localStorage.setItem('j3fx-muted-conversations', JSON.stringify(next))
  }

  function focusMessageSearch() {
    setShowDetails(false)
    requestAnimationFrame(() => messageSearchRef.current?.focus())
  }

  async function openExternalUrl(url: string) {
    if (Capacitor.isNativePlatform()) {
      await Browser.open({ url })
      return
    }
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  async function manageGroupMember(action: 'add' | 'remove') {
    if (!supabase || !selected || !selected.is_group) return
    const username = window.prompt(action === 'add' ? 'Username to add' : 'Username to remove')?.trim().toLowerCase()
    if (!username) return
    if (action === 'add') {
      const { error: actionError } = await supabase.rpc('add_group_member', { target_conversation: selected.id, target_username: username })
      if (actionError) setError(actionError.message); else setError('Member added.')
      return
    }
    const { data: member, error: lookupError } = await supabase.from('profiles').select('id').eq('username', username).single()
    if (lookupError || !member) { setError(lookupError?.message ?? 'Username not found.'); return }
    const { error: actionError } = await supabase.rpc('remove_group_member', { target_conversation: selected.id, target_user: member.id })
    if (actionError) setError(actionError.message); else setError('Member removed.')
  }

  async function deleteAccount() {
    if (!supabase || !window.confirm('Delete your account and profile permanently?')) return
    const { error: deleteError } = await supabase.rpc('delete_my_account')
    if (deleteError) setError(deleteError.message)
    else await supabase.auth.signOut()
  }

  async function downloadAttachment(attachment: Attachment) {
    if (!supabase) return
    const { data, error: downloadError } = await supabase.storage.from('message-media').createSignedUrl(attachment.storage_path, 120)
    if (downloadError || !data) { setError(downloadError?.message ?? 'Unable to create a download URL.'); return }
    await openExternalUrl(data.signedUrl)
  }

  async function authenticate(event: FormEvent) {
    event.preventDefault(); setError('')
    if (!supabase) { setError('Configure VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY first.'); return }
    const result = authMode === 'login'
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({ email, password, options: { data: { display_name: displayName }, emailRedirectTo: Capacitor.isNativePlatform() ? 'com.j3fx.messenger://auth/callback' : window.location.origin } })
    if (result.error) setError(result.error.message)
    else if (authMode === 'signup') setError('Account created. Check your email if confirmation is enabled.')
  }

  async function signOut() {
    if (!supabase) return
    if (session && pushTokenRef.current) {
      const { error: tokenDeleteError } = await supabase
        .from('push_devices')
        .delete()
        .eq('user_id', session.user.id)
        .eq('token', pushTokenRef.current)
      if (tokenDeleteError) {
        setCallError(`Could not remove this device from push notifications: ${tokenDeleteError.message}`)
        console.error('Push token cleanup failed during sign out:', tokenDeleteError.message)
      } else {
        pushTokenRef.current = null
      }
    }
    const { error: signOutError } = await supabase.auth.signOut()
    if (signOutError) setCallError(`Sign out failed: ${signOutError.message}`)
  }

  async function notifyMessage(messageId: string) {
    if (!supabase) return
    const { error: pushError } = await invokeWithFreshSession('j3fx-push', {
      body: { action: 'message', messageId },
    })
    if (pushError) {
      console.error('Message was sent, but its push notification failed:', pushError.message)
      setCallError(`Message sent, but background notification failed: ${pushError.message}`)
    }
  }

  async function startCall(callType: CallType) {
    if (!supabase || !selectedId || startingCall || selected?.is_group) return
    setStartingCall(true)
    setCallError('')
    const { data, error: callStartError } = await invokeWithFreshSession<{ call: CallSession; notificationWarning?: string }>(
      'j3fx-calls',
      { body: { action: 'start', conversationId: selectedId, callType } },
    )
    setStartingCall(false)
    if (callStartError) { setCallError(await getCallFunctionError(callStartError)); return }
    if (!data?.call?.id) {
      setCallError('The call service returned an invalid response.')
      return
    }
    if (data.notificationWarning) setCallError(data.notificationWarning)
    setActiveCall({
      id: data.call.id,
      conversationId: data.call.conversation_id,
      role: 'caller',
      callType: data.call.call_type,
      peerName: selected?.title ?? selected?.nickname ?? selected?.other.display_name ?? 'Contact',
    })
  }

  async function joinCall(call: CallSession) {
    if (!supabase || joiningCallId) return
    setJoiningCallId(call.id)
    setCallError('')
    const { error: joinError } = await invokeWithFreshSession('j3fx-calls', {
      body: { action: 'accept', callId: call.id },
    })
    setJoiningCallId(null)
    if (joinError) { setCallError(await getCallFunctionError(joinError)); return }
    setIncomingCall(null)
    setActiveCall({
      id: call.id,
      conversationId: call.conversation_id,
      role: 'callee',
      callType: call.call_type,
      peerName: conversations.find((item) => item.id === call.conversation_id)?.title
        ?? conversations.find((item) => item.id === call.conversation_id)?.other.display_name
        ?? 'Contact',
    })
  }

  async function declineCall(call: CallSession) {
    if (!supabase) return
    dismissedCallIdRef.current = call.id
    setIncomingCall(null)
    const { error: declineError } = await invokeWithFreshSession('j3fx-calls', {
      body: { action: 'decline', callId: call.id },
    })
    if (declineError) setCallError(await getCallFunctionError(declineError))
  }

  async function closeCall(callId: string, notifyParticipants: boolean) {
    setActiveCall((current) => current?.id === callId ? null : current)
    setIncomingCall((current) => current?.id === callId ? null : current)
    if (!notifyParticipants || !supabase) return
    const { error: endError } = await invokeWithFreshSession('j3fx-calls', { body: { action: 'end', callId } })
    if (endError) setCallError(await getCallFunctionError(endError))
  }

  function finishRemoteCall() {
    setActiveCall(null)
    setIncomingCall(null)
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault()
    const body = composer.trim()
    if ((!body && !selectedFile) || !selectedId || !session || !supabase) return
    const clientId = crypto.randomUUID()
    const item = { clientId, conversationId: selectedId, body: body || 'Attachment' }
    if (!navigator.onLine) {
      if (selectedFile) {
        setMessageSendError({ conversationId: selectedId, message: 'Attachments cannot be queued while offline. Reconnect before sending this file.' })
        return
      }
      const next = [...outbox, item]
      scrollLatestPendingRef.current = true
      setOutbox(next)
      localStorage.setItem(queueKey, JSON.stringify(next))
      setComposer('')
      setMessageSendError({ conversationId: selectedId, message: 'You are offline. This message is saved on this device and will retry when you reconnect.' })
      return
    }
    setComposer('')
    const { data, error: sendError } = await supabase.from('messages').insert({ conversation_id: selectedId, sender_id: session.user.id, body: body || 'Attachment', client_id: clientId }).select().single()
    if (sendError) {
      setMessageSendError({
        conversationId: selectedId,
        message: selectedFile
          ? `Message was not confirmed by the server. Your text and attachment are still here; retry after resolving this error: ${sendError.message}`
          : `Message was not saved to the server yet. It is queued on this device and will retry: ${sendError.message}`,
      })
      if (selectedFile) {
        setComposer(body)
        return
      }
      const next = [...outbox, item]
      setOutbox(next)
      localStorage.setItem(queueKey, JSON.stringify(next))
    }
    else if (data) {
      setMessageSendError((current) => current?.conversationId === selectedId ? null : current)
      scrollLatestPendingRef.current = true
      setMessages((current) => current.some((message) => message.id === data.id) ? current : [...current, data])
      void notifyMessage(data.id)
      if (selectedFile) {
        const file = selectedFile
        const path = `${session.user.id}/${data.id}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`
        const { error: uploadError } = await supabase.storage.from('message-media').upload(path, file, { contentType: file.type, upsert: false })
        if (uploadError) setMessageSendError({ conversationId: selectedId, message: `Message was sent, but the attachment upload failed: ${uploadError.message}` })
        else {
          const { data: attachmentData, error: metadataError } = await supabase.from('message_attachments').insert({ message_id: data.id, owner_id: session.user.id, storage_path: path, mime_type: file.type || 'application/octet-stream', byte_size: file.size }).select('*').single()
          if (metadataError) setMessageSendError({ conversationId: selectedId, message: `Message was sent, but its attachment details could not be saved: ${metadataError.message}` })
          else if (attachmentData) {
            setAttachments((current) => [...current.filter((item) => item.id !== attachmentData.id), attachmentData])
            if (attachmentData.mime_type.startsWith('image/')) void loadAttachmentUrl(attachmentData)
          }
        }
      }
    } else {
      setMessageSendError({ conversationId: selectedId, message: 'The server did not confirm whether this message was saved. Please check the conversation before trying again.' })
      setComposer(body)
      return
    }
    setSelectedFile(null)
    void loadConversations()
  }

  async function startConversation(event: FormEvent) {
    event.preventDefault()
    const username = newUsername.trim().toLowerCase()
    if (!supabase || !username) return
    const { data, error: startError } = await supabase.rpc('start_direct_conversation', { target_username: username })
    if (startError) { setError(startError.message); return }
    setNewUsername('')
    setShowNewConversation(false)
    await loadConversations()
    setSelectedId(data)
  }

  async function createGroup(event: FormEvent) {
    event.preventDefault()
    if (!supabase) return
    const usernames = newUsername.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean)
    const { data, error: createError } = await supabase.rpc('create_group_conversation', { group_title: groupTitle.trim(), member_usernames: usernames })
    if (createError) { setError(createError.message); return }
    setNewUsername('')
    setGroupTitle('')
    setShowNewConversation(false)
    await loadConversations()
    setSelectedId(data)
  }

  async function flushOutbox() {
    if (!supabase || !session || !navigator.onLine) return
    const pending = [...outbox]
    for (const item of pending) {
      const { data, error: sendError } = await supabase.from('messages')
        .insert({ conversation_id: item.conversationId, sender_id: session.user.id, body: item.body, client_id: item.clientId })
        .select('*')
        .single()
      let savedMessage = data
      if (sendError) {
        const { data: existingMessage, error: lookupError } = await supabase.from('messages')
          .select('*')
          .eq('sender_id', session.user.id)
          .eq('client_id', item.clientId)
          .maybeSingle()
        if (lookupError || !existingMessage) {
          if (selectedId === item.conversationId) {
            setMessageSendError({
              conversationId: item.conversationId,
              message: `Message is still queued on this device and was not confirmed by the server: ${lookupError?.message ?? sendError.message}`,
            })
          }
          continue
        }
        savedMessage = existingMessage
      }
      pending.splice(pending.indexOf(item), 1)
      if (savedMessage) {
        if (selectedId === item.conversationId) {
          scrollLatestPendingRef.current = true
          setMessages((current) => current.some((message) => message.id === savedMessage.id) ? current : [...current, savedMessage])
          setMessageSendError((current) => current?.conversationId === item.conversationId ? null : current)
        }
        void notifyMessage(savedMessage.id)
      }
    }
    setOutbox(pending); localStorage.setItem(queueKey, JSON.stringify(pending))
  }
  useEffect(() => { window.addEventListener('online', flushOutbox); void flushOutbox(); return () => window.removeEventListener('online', flushOutbox) }, [session, selectedId, outbox.length])

  const visibleConversations = useMemo(() => conversations.filter((item) => (conversationFilter === 'all' || item.is_group) && ((item.title ?? item.other.display_name).toLowerCase().includes(search.toLowerCase()) || item.other.display_name.toLowerCase().includes(search.toLowerCase()) || item.other.username.toLowerCase().includes(search.toLowerCase()))), [conversations, search, conversationFilter])
  if (!session) return <AuthScreen {...{ authMode, setAuthMode, email, setEmail, password, setPassword, displayName, setDisplayName, error, authenticate }} />
  const selected = conversations.find((item) => item.id === selectedId)
  return <main className={`shell ${selected ? 'conversation-open' : ''}`}>
    <aside className="sidebar">
      <header className="brand"><img className="logo-image" src={appIcon} alt="J3FX" /><div><strong>J3FX</strong><span>private messages</span></div><button className="icon-button" onClick={() => void signOut()} aria-label="Sign out">↗</button></header>
      <div className="profile-chip"><div className="avatar">{profileAvatarUrl ? <img src={profileAvatarUrl} alt="" /> : initials(profile?.display_name ?? session.user.email ?? 'You')}</div><div><strong>{profile?.display_name ?? 'Your account'}</strong><span>@{profile?.username ?? session.user.email}</span></div><button className="account-delete" onClick={() => void deleteAccount()} title="Delete account">Delete</button></div>
      <label className="search"><span>⌕</span><input placeholder="Find people by name or username" value={peopleSearch} onChange={(event) => setPeopleSearch(event.target.value)} /></label>
      {people.length > 0 && <div className="people-results">{people.map((person) => <button className="person-result" key={person.id} onClick={() => void choosePerson(person)}><div className="avatar">{initials(person.display_name)}</div><div><strong>{person.display_name}</strong><span>@{person.username}</span></div></button>)}</div>}
      <label className="search"><span>☷</span><input placeholder="Filter conversations" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <nav className="chat-tabs" aria-label="Conversation filters"><button className={conversationFilter === 'all' ? 'selected' : ''} onClick={() => setConversationFilter('all')}>All</button><button onClick={() => setError('Unread filtering will use read receipts as messages arrive.')}>Unread</button><button className={conversationFilter === 'groups' ? 'selected' : ''} onClick={() => setConversationFilter('groups')}>Groups</button><button onClick={() => setError('Communities are not enabled for this private messenger.')}>Communities</button></nav>
      <div className="section-label">Messages <button className="new-conversation" onClick={() => setShowNewConversation((value) => !value)} aria-label="New conversation">＋</button><span>{visibleConversations.length}</span></div>
      {showNewConversation && <><div className="conversation-tabs"><button className={newConversationMode === 'direct' ? 'selected' : ''} onClick={() => setNewConversationMode('direct')}>Direct</button><button className={newConversationMode === 'group' ? 'selected' : ''} onClick={() => setNewConversationMode('group')}>Group</button></div>{newConversationMode === 'direct' ? <form className="new-conversation-form" onSubmit={startConversation}><input required pattern="[a-z0-9_]{3,32}" placeholder="username" value={newUsername} onChange={(event) => setNewUsername(event.target.value)} /><button>Start</button></form> : <form className="new-conversation-form group-form" onSubmit={createGroup}><input required placeholder="Group name" value={groupTitle} onChange={(event) => setGroupTitle(event.target.value)} /><input required placeholder="usernames, comma separated" value={newUsername} onChange={(event) => setNewUsername(event.target.value)} /><button>Create</button></form>}</>}
      <div ref={conversationListRef} className="conversation-list" onScroll={handleConversationScroll}>{visibleConversations.map((item) => <button className={`conversation ${item.id === selectedId ? 'active' : ''}`} key={item.id} onClick={() => setSelectedId(item.id)}><div className="avatar-wrap"><div className="avatar">{item.other.avatar_url ? <img src={item.other.avatar_url} alt="" /> : initials(item.title ?? item.other.display_name)}</div><span className={`presence-indicator ${isOnline(item.other.last_seen_at) ? 'online' : 'offline'}`} title={presenceText(item.other.last_seen_at)} /></div><div className="conversation-copy"><strong>{item.title ?? item.other.display_name}</strong><span>{item.is_group ? 'Group conversation' : presenceText(item.other.last_seen_at)}</span></div><time>{formatTime(item.updated_at)}</time></button>)}{loadingConversations && <p className="empty center">Loading conversations…</p>}{!loadingConversations && !visibleConversations.length && <p className="empty">No conversations yet. Start a direct or group conversation.</p>}</div>
      <div className="sidebar-footer"><label className="profile-photo"><input type="file" accept="image/*" onChange={(event) => selectProfilePhoto(event)} /><span>Change photo</span></label><select value={theme} onChange={(event) => setTheme(event.target.value)} aria-label="Chat theme"><option value="mist">Light theme</option><option value="dark">Dark theme</option><option value="mint">Mint theme</option></select><button className="logout-button" onClick={() => void signOut()}>Log out</button></div>
    </aside>
    {incomingCall && !activeCall && <div className="call-incoming-layer" role="dialog" aria-modal="true" aria-label="Incoming call">
      <div className="call-incoming-card">
        <div className="call-avatar">J</div>
        <span className="call-eyebrow">INCOMING {incomingCall.call_type.toUpperCase()} CALL</span>
        <h2>{conversations.find((item) => item.id === incomingCall.conversation_id)?.title ?? conversations.find((item) => item.id === incomingCall.conversation_id)?.other.display_name ?? 'J3FX conversation'}</h2>
        <div className="call-incoming-actions">
          <button className="call-dismiss" onClick={() => void declineCall(incomingCall)}>Decline</button>
          <button className="call-accept" onClick={() => void joinCall(incomingCall)} disabled={joiningCallId === incomingCall.id}>{joiningCallId === incomingCall.id ? 'Joining…' : 'Join call'}</button>
        </div>
        {ringSoundBlocked && <button className="call-enable-sound" onClick={() => void enableIncomingRingtone()}>Enable ringtone</button>}
        {callError && <p className="call-error">{callError}</p>}
      </div>
    </div>}
    <section className="chat">
      {!selected ? <div className="welcome"><div className="welcome-mark">✦</div><h1>Your conversations,<br /><em>kept in sync.</em></h1><p>Choose a conversation to start messaging. Your history lives securely in Supabase and follows you across devices.</p></div> : <><header className="chat-header"><button className="mobile-back" onClick={() => setSelectedId(null)} aria-label="Back to conversations"><BackIcon /></button><div className="avatar-wrap"><div className="avatar">{selected.other.avatar_url ? <img src={selected.other.avatar_url} alt="" /> : initials(selected.title ?? selected.other.display_name)}</div><span className={`presence-indicator header-presence ${isOnline(selected.other.last_seen_at) ? 'online' : 'offline'}`} title={presenceText(selected.other.last_seen_at)} /></div><div className="chat-title"><strong>{selected.title ?? selected.nickname ?? selected.other.display_name}</strong><span><span className={`presence-label ${isOnline(selected.other.last_seen_at) ? 'online-text' : ''}`}>{presenceText(selected.other.last_seen_at)}</span>{selected.is_group ? ' · Group conversation' : ' · @' + selected.other.username}</span></div><div className="header-actions"><button className="circle-action" onClick={() => void startCall('audio')} disabled={selected.is_group || startingCall || Boolean(activeCall)} title="Start audio call"><img src={voiceCallIcon} alt="" /></button><button className="circle-action" onClick={() => void startCall('video')} disabled={selected.is_group || startingCall || Boolean(activeCall)} title="Start video call"><img src={videoCallIcon} alt="" /></button><button className="circle-action" onClick={() => setShowDetails((value) => !value)} title="Open chat information">ⓘ</button></div></header><form className="message-search" onSubmit={searchMessages}><input ref={messageSearchRef} placeholder="Search messages in this conversation" value={messageSearch} onChange={(event) => setMessageSearch(event.target.value)} /><button>{searchingMessages ? '…' : 'Search'}</button></form>                              <div ref={messageListRef} className="message-list">{messages.map((message) => { const count = reactions.filter((reaction) => reaction.message_id === message.id && reaction.reaction === 'heart').length; return <div className={`message-row ${message.sender_id === session.user.id ? 'mine' : ''}`} key={message.id}>      <div className="bubble">{message.body}{message.edited_at && <i className="edited"> edited</i>}{attachments.filter((attachment) => attachment.message_id === message.id).map((attachment) =>             attachment.mime_type.startsWith('image/') ? <button className="image-attachment" key={attachment.id} onClick={() => void openAttachment(attachment)}><span className="image-attachment-frame">{attachmentUrls[attachment.id] ?       <img loading="lazy" decoding="async" src={attachmentUrls[attachment.id]} alt="Sent attachment" onLoad={() => { const list = messageListRef.current; if (list && (scrollLatestPendingRef.current || list.scrollHeight - list.scrollTop - list.clientHeight < 120)) list.scrollTop = list.scrollHeight }} onError={() => void loadAttachmentUrl(attachment)} /> : <span className="image-loading">Loading image…</span>}</span></button> : <button className="attachment-link" key={attachment.id} onClick={() => void openAttachment(attachment)}>Open attachment ({Math.ceil(attachment.byte_size / 1024)} KB</button>)}<div className="message-actions">            <button onClick={() => void toggleReaction(message.id)} aria-label="React with heart">❤️</button>{message.sender_id === session.user.id && <><button onClick={() => void editMessage(message)} aria-label="Edit message">✎</button><button onClick={() => void deleteMessage(message)} aria-label="Delete message">×</button></>}</div>      <small>{formatTime(message.created_at)} {message.sender_id === session.user.id ? '· ' + (receipts.some((receipt) => receipt.message_id === message.id && receipt.read_at) ? 'read' : receipts.some((receipt) => receipt.message_id === message.id && receipt.delivered_at) ? 'delivered' : message.status) : ''}      </small>{count > 0 && <span className="reaction-badge" title={`${count} heart reaction${count === 1 ? '' : 's'}`}>❤️{count > 1 ? ` ${count}` : ''}</span>}</div></div> })}{!messages.length && <p className="empty center">No messages yet. Say hello.</p>}{hasOlderMessages && <button className="load-older" onClick={() => void loadOlderMessages()} disabled={loadingOlder}>{loadingOlder ? 'Loading…' : 'Load older messages'}</button>}      </div><form className="composer" onSubmit={sendMessage}><input ref={fileInput} className="file-input" type="file" accept="image/*,video/*,audio/*,application/pdf" onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)} />      <button type="button" className="attach-button" onClick={() => fileInput.current?.click()} aria-label="Attach file"><AttachIcon /></button><input value={composer} onChange={(event) => setComposer(event.target.value)} placeholder={selectedFile ? selectedFile.name : navigator.onLine ? 'Write a message…' : 'Offline — queued until reconnect'} />      <button className="send-button" disabled={!composer.trim() && !selectedFile} aria-label="Send message"><SendIcon /></button></form></>}
      {previewUrl && <div className="image-modal" onClick={() => setPreviewUrl(null)}><img src={previewUrl} alt="Full-size attachment" /></div>}
      {cropSource && <div className="crop-modal"><div className="crop-panel"><h2>Crop profile photo</h2><p>Drag the image to choose the crop area.</p><div className="crop-viewport" onPointerDown={handleCropPointerDown} onPointerMove={handleCropPointerMove} onPointerUp={handleCropPointerUp} onPointerCancel={handleCropPointerUp}><img src={cropSource} alt="Crop preview" style={{ transform: `translate(${cropOffset.x}px, ${cropOffset.y}px) scale(${cropZoom})` }} /><div className="crop-guide" /></div><label className="crop-zoom">Zoom <input type="range" min="1" max="3" step="0.01" value={cropZoom} onChange={(event) => setCropZoom(Number(event.target.value))} /></label><div><button onClick={() => { URL.revokeObjectURL(cropSource); setCropSource(null); setProfileFile(null); setCropZoom(1); setCropOffset({ x: 0, y: 0 }) }}>Cancel</button><button className="primary crop-confirm" onClick={() => void uploadProfilePhoto()}>Use photo</button></div></div></div>}
    </section>
    {activeCall && supabase && <PeerCall
      key={activeCall.id}
      callId={activeCall.id}
      callType={activeCall.callType}
      role={activeCall.role}
      userId={session.user.id}
      peerName={activeCall.peerName}
      supabase={supabase}
      onHangUp={() => void closeCall(activeCall.id, true)}
      onRemoteEnd={finishRemoteCall}
      onError={setCallError}
    />}
    {messageListRef.current && callHistory.length > 0 && createPortal(
      <div className="call-history-feed" aria-label="Call history">
        {callHistory.map((call) => {
          const duration = call.status === 'ended' ? formatCallDuration(call.accepted_at, call.ended_at) : ''
          const state = call.status === 'declined' ? 'Call declined' : call.status === 'missed' ? 'Missed call' : 'Call ended'
          return <div className={`call-history-row ${call.caller_id === session.user.id ? 'mine' : ''}`} key={call.id}>
            <div className="call-history-card">
              <span className="call-history-icon" aria-hidden="true">{call.call_type === 'video' ? '▣' : '◖'}</span>
              <span className="call-history-copy">
                <strong>{call.call_type === 'video' ? 'Video call' : 'Voice call'}</strong>
                <span>{state}</span>
                {duration && <small>{duration}</small>}
              </span>
              <time>{formatTime(call.created_at)}</time>
            </div>
          </div>
        })}
      </div>,
      messageListRef.current,
    )}
    {messageListRef.current && selectedId && createPortal(
      <div className="message-status-feed" aria-label="Message delivery status">
        {outbox.filter((item) => item.conversationId === selectedId).map((item) => (
          <div className="message-row mine message-pending" key={item.clientId}>
            <div className="bubble">
              {item.body}
              <small>Not delivered · queued on this device</small>
            </div>
          </div>
        ))}
        {messagesLoadError?.conversationId === selectedId && <div className="message-inline-error" role="alert">
          <span>Could not load messages: {messagesLoadError.message}</span>
          <button type="button" onClick={() => void loadMessages(selectedId)}>Retry</button>
        </div>}
        {messageSendError?.conversationId === selectedId && <div className="message-inline-error" role="alert">
          <span>{messageSendError.message}</span>
          <button type="button" onClick={() => setMessageSendError(null)} aria-label="Dismiss message status">×</button>
        </div>}
      </div>,
      messageListRef.current,
    )}
    {callError && !incomingCall && <div className="call-notice" role="alert">
      <span>{callError}</span>
      <button onClick={() => setCallError('')} aria-label="Dismiss call error">×</button>
    </div>}
    {startingCall && <div className="call-notice call-progress" role="status"><span>Preparing your call…</span></div>}
    {selected && showDetails && <aside className="details-panel">
      <button className="details-close" onClick={() => setShowDetails(false)} aria-label="Close conversation details">×</button>
      <div className="details-profile"><div className="details-avatar-wrap"><div className="details-avatar">{selected.other.avatar_url ? <img src={selected.other.avatar_url} alt="" /> : initials(selected.title ?? selected.other.display_name)}</div><span className={`presence-indicator details-presence ${isOnline(selected.other.last_seen_at) ? 'online' : 'offline'}`} /></div><h2>{selected.title ?? selected.nickname ?? selected.other.display_name}</h2><p>@{selected.other.username}</p><p className={isOnline(selected.other.last_seen_at) ? 'online-text' : ''}>{presenceText(selected.other.last_seen_at)}</p></div>
      <div className="details-actions"><button onClick={() => setError('Profile details are represented by this chat information panel.')}>◉<span>Profile</span></button><button onClick={toggleMute}>●<span>{mutedConversationIds.includes(selected.id) ? 'Unmute' : 'Mute'}</span></button><button onClick={focusMessageSearch}>⌕<span>Search</span></button></div>
      {(['Chat info', 'Customize chat', 'Media, files and links', 'Privacy & support'] as const).map((section) => <div className="details-section" key={section}><button className="details-section-toggle" onClick={() => setDetailsSection((current) => current === section ? null : section)}><strong>{section}</strong><span>{detailsSection === section ? '⌃' : '⌄'}</span></button>{detailsSection === section && <div className="details-content">{section === 'Chat info' && <><p>{selected.is_group ? 'Group conversation' : 'Direct conversation'}</p><p>Started with @{selected.other.username}</p><button onClick={() => void changeNickname()}>Change nickname</button></>}{section === 'Customize chat' && <><label>Theme<select value={theme} onChange={(event) => setTheme(event.target.value)}><option value="mist">Mist</option><option value="night">Night</option><option value="mint">Mint</option></select></label><button onClick={() => void changeNickname()}>Set nickname</button></>}{section === 'Media, files and links' && <><p>{attachments.length} attachment{attachments.length === 1 ? '' : 's'} in this loaded history.</p>{attachments.slice(0, 5).map((attachment) => <button key={attachment.id} onClick={() => void openAttachment(attachment)}>{attachment.mime_type.startsWith('image/') ? 'Image' : 'Attachment'} · {Math.ceil(attachment.byte_size / 1024)} KB</button>)}</>}{section === 'Privacy & support' && <><button onClick={() => void blockOtherUser()}>Block user</button><button onClick={() => void reportOtherUser()}>Report a problem</button><button onClick={() => void leaveSelectedConversation()}>Leave conversation</button></>}</div>}</div>)}
    </aside>}
  </main>
}

function AuthScreen(props: { authMode: 'login' | 'signup'; setAuthMode: (mode: 'login' | 'signup') => void; email: string; setEmail: (value: string) => void; password: string; setPassword: (value: string) => void; displayName: string; setDisplayName: (value: string) => void; error: string; authenticate: (event: FormEvent) => void }) {
  return <main className="auth auth-screen">
    <section className="auth-showcase" aria-label="J3FX Messenger">
      <img className="auth-showcase-art" src={appIcon} alt="" />
      <div className="auth-showcase-shade" />
      <div className="auth-showcase-content">
        <div className="auth-brand"><img src={appIcon} alt="" /><span>J3FX <small>MESSENGER</small></span></div>
        <div className="auth-showcase-copy">
          <span className="auth-showcase-kicker"><i /> YOUR PEOPLE, IN REACH</span>
          <h1>Good conversations<br />make <em>every day.</em></h1>
          <p>A calmer place for the people and conversations you want to keep close.</p>
        </div>
        <div className="auth-showcase-foot"><span>PRIVATE BY DESIGN</span><span>MADE TO STAY IN TOUCH</span></div>
      </div>
    </section>
    <section className="auth-form-panel">
      <div className="auth-form-card">
        <div className="auth-mobile-brand"><img src={appIcon} alt="" /><span>J3FX MESSENGER</span></div>
        <p className="auth-form-eyebrow">{props.authMode === 'login' ? 'WELCOME BACK' : 'START SOMETHING GOOD'}</p>
        <h2>{props.authMode === 'login' ? 'Sign in to your space.' : 'Create your account.'}</h2>
        <p className="auth-form-intro">{props.authMode === 'login' ? 'Pick up right where your conversations left off.' : 'A few details and you’re ready to connect.'}</p>
        <div className="tabs auth-tabs" role="tablist" aria-label="Account access">
          <button type="button" role="tab" aria-selected={props.authMode === 'login'} className={props.authMode === 'login' ? 'selected' : ''} onClick={() => props.setAuthMode('login')}>Sign in</button>
          <button type="button" role="tab" aria-selected={props.authMode === 'signup'} className={props.authMode === 'signup' ? 'selected' : ''} onClick={() => props.setAuthMode('signup')}>Create account</button>
        </div>
        <form className="auth-form" onSubmit={props.authenticate}>
          {props.authMode === 'signup' && <label><span>Your name</span><input required autoComplete="name" placeholder="How should we call you?" value={props.displayName} onChange={(event) => props.setDisplayName(event.target.value)} /></label>}
          <label><span>Email address</span><input required type="email" autoComplete="email" placeholder="you@example.com" value={props.email} onChange={(event) => props.setEmail(event.target.value)} /></label>
          <label><span>Password</span><input required minLength={8} type="password" autoComplete={props.authMode === 'login' ? 'current-password' : 'new-password'} placeholder="At least 8 characters" value={props.password} onChange={(event) => props.setPassword(event.target.value)} /></label>
          <button className="auth-submit">{props.authMode === 'login' ? 'Continue to J3FX' : 'Create my account'}<span aria-hidden="true">→</span></button>
        </form>
        {props.error && <p className="error auth-error" role="alert">{props.error}</p>}
        <p className="auth-privacy"><span aria-hidden="true">✦</span> Your conversations are private and protected.</p>
      </div>
      <footer className="auth-footer"><span>© J3FX Messenger</span><span>Thoughtful conversations, wherever you are.</span></footer>
    </section>
  </main>
}

import { useEffect, useRef, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { invokeWithFreshSession } from '../lib/supabase'

type CallType = 'audio' | 'video'
type CallRole = 'caller' | 'callee'
type CallStatus = 'Connecting…' | 'Ringing…' | 'Connected' | 'Reconnecting…' | 'Connection is weak' | 'Call failed' | 'Call declined'
type Signal = { id: string; call_id: string; from_user: string; signal_type: 'offer' | 'answer' | 'candidate'; payload: RTCSessionDescriptionInit | RTCIceCandidateInit }
type Props = {
  callId: string
  callType: CallType
  role: CallRole
  userId: string
  peerName: string
  supabase: SupabaseClient
  onHangUp: () => void
  onRemoteEnd: (status?: string) => void
  onError: (message: string) => void
}

const baseIceServers: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]

function describeError(error: unknown) {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : 'Unknown WebRTC error.'
}

export function PeerCall({ callId, callType, role, userId, peerName, supabase, onHangUp, onRemoteEnd, onError }: Props) {
  const [status, setStatus] = useState<CallStatus>(role === 'caller' ? 'Ringing…' : 'Connecting…')
  const [muted, setMuted] = useState(false)
  const [cameraEnabled, setCameraEnabled] = useState(callType === 'video')
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null)
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([])
  const [audioOutput, setAudioOutput] = useState('default')
  const [turnAvailable, setTurnAvailable] = useState(false)
  const [lowDataTip, setLowDataTip] = useState('')
  const [terminalMessage, setTerminalMessage] = useState('')
  const remoteVideoRef = useRef<HTMLVideoElement>(null)
  const localVideoRef = useRef<HTMLVideoElement>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const videoSenderRef = useRef<RTCRtpSender | null>(null)
  const channelRef = useRef<ReturnType<SupabaseClient['channel']> | null>(null)
  const seenSignalsRef = useRef(new Set<string>())
  const queuedSignalsRef = useRef<Signal[]>([])
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([])
  const processorRef = useRef(Promise.resolve())
  const readyRef = useRef(false)
  const offerSentRef = useRef(false)
  const remoteDescriptionReadyRef = useRef(false)
  const handledRemoteEndRef = useRef(false)
  const connectedAtRef = useRef<number | null>(null)
  const weakNetworkRef = useRef(false)
  const previousVideoStatsRef = useRef({ received: 0, lost: 0 })
  const disposedRef = useRef(false)
  const callStatusRef = useRef<CallStatus>(status)
  const turnAvailableRef = useRef(false)
  const acceptedRef = useRef(false)
  const callbacksRef = useRef({ onHangUp, onRemoteEnd, onError })
  const connectionTimerRef = useRef<number | null>(null)
  const ringTimerRef = useRef<number | null>(null)
  const statsTimerRef = useRef<number | null>(null)
  const terminalTimerRef = useRef<number | null>(null)

  useEffect(() => { callStatusRef.current = status }, [status])
  callbacksRef.current = { onHangUp, onRemoteEnd, onError }

  useEffect(() => {
    disposedRef.current = false
    const handleError = (title: string, error: unknown) => {
      if (disposedRef.current) return
      const detail = describeError(error)
      console.error(`${title}:`, error)
      callbacksRef.current.onError(`${title}: ${detail}`)
      callbacksRef.current.onHangUp()
    }

    const sendSignal = async (type: Signal['signal_type'], payload: Signal['payload']) => {
      const { error } = await supabase.from('call_signals').insert({
        call_id: callId,
        from_user: userId,
        signal_type: type,
        payload,
      })
      if (error) throw new Error(`Could not send call signaling (${error.message}).`)
    }

    const startOffer = async (peer: RTCPeerConnection) => {
      if (offerSentRef.current || peer.signalingState !== 'stable') return
      offerSentRef.current = true
      try {
        const offer = await peer.createOffer()
        await peer.setLocalDescription(offer)
        if (peer.localDescription) await sendSignal('offer', peer.localDescription.toJSON())
      } catch (error) {
        handleError('Could not start the call', error)
      }
    }

    const processSignal = async (signal: Signal) => {
      if (disposedRef.current || signal.from_user === userId || seenSignalsRef.current.has(signal.id)) return
      const peer = pcRef.current
      if (!peer) {
        queuedSignalsRef.current.push(signal)
        return
      }
      seenSignalsRef.current.add(signal.id)
      try {
        if (signal.signal_type === 'offer' && role === 'callee') {
          await peer.setRemoteDescription(signal.payload as RTCSessionDescriptionInit)
          remoteDescriptionReadyRef.current = true
          const answer = await peer.createAnswer()
          await peer.setLocalDescription(answer)
          if (peer.localDescription) await sendSignal('answer', peer.localDescription.toJSON())
          for (const candidate of pendingCandidatesRef.current.splice(0)) {
            await peer.addIceCandidate(candidate)
          }
        } else if (signal.signal_type === 'answer' && role === 'caller' && !remoteDescriptionReadyRef.current) {
          await peer.setRemoteDescription(signal.payload as RTCSessionDescriptionInit)
          remoteDescriptionReadyRef.current = true
          for (const candidate of pendingCandidatesRef.current.splice(0)) {
            await peer.addIceCandidate(candidate)
          }
        } else if (signal.signal_type === 'candidate') {
          const candidate = signal.payload as RTCIceCandidateInit
          if (remoteDescriptionReadyRef.current) await peer.addIceCandidate(candidate)
          else pendingCandidatesRef.current.push(candidate)
        }
      } catch (error) {
        handleError('Call signaling failed', error)
      }
    }

    const drainSignals = () => {
      processorRef.current = processorRef.current.then(async () => {
        while (queuedSignalsRef.current.length && !disposedRef.current) {
          const next = queuedSignalsRef.current.shift()
          if (next) await processSignal(next)
        }
      }).catch((error: unknown) => handleError('Call signaling failed', error))
    }

    const handleIncomingSignal = (signal: Signal) => {
      if (signal.from_user === userId || seenSignalsRef.current.has(signal.id)) return
      if (!readyRef.current) queuedSignalsRef.current.push(signal)
      else {
        queuedSignalsRef.current.push(signal)
        drainSignals()
      }
    }

    const initialize = async () => {
      const turnResult = await invokeWithFreshSession<{ configured: boolean; iceServers?: RTCIceServer[] }>(
        'j3fx-calls',
        { body: { action: 'turn-credentials' } },
      )
      const iceServers = turnResult.data?.configured && turnResult.data.iceServers?.length
        ? [...baseIceServers, ...turnResult.data.iceServers]
        : baseIceServers
      const hasTurn = Boolean(turnResult.data?.configured && turnResult.data.iceServers?.length)
      turnAvailableRef.current = hasTurn
      setTurnAvailable(hasTurn)
      if (turnResult.error) console.warn('Temporary TURN credentials unavailable; attempting direct WebRTC only:', turnResult.error.message)

      const { data: session, error: sessionError } = await supabase
        .from('call_sessions')
        .select('id,status,expires_at')
        .eq('id', callId)
        .maybeSingle()
      if (sessionError) throw new Error(`Unable to load call state: ${sessionError.message}`)
      if (!session || session.status === 'ended' || session.status === 'declined' || session.status === 'missed') {
        if (session?.status === 'declined' && role === 'caller') {
          setStatus('Call declined')
          setTerminalMessage(`${peerName} declined the call`)
          localStreamRef.current?.getTracks().forEach((track) => track.stop())
          pcRef.current?.close()
          setLocalStream(null)
          setRemoteStream(null)
          terminalTimerRef.current = window.setTimeout(() => callbacksRef.current.onRemoteEnd('declined'), 3000)
        } else {
          callbacksRef.current.onRemoteEnd(session?.status)
        }
        return
      }

      const audioConstraints: MediaTrackConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      }
      let media: MediaStream
      if (callType === 'video') {
        try {
          media = await navigator.mediaDevices.getUserMedia({
            audio: audioConstraints,
            video: { width: { ideal: 320, max: 320 }, height: { ideal: 240, max: 240 }, frameRate: { ideal: 12, max: 15 } },
          })
        } catch (constrainedVideoError) {
          console.warn('Could not start constrained video capture; retrying with the default camera settings:', constrainedVideoError)
          try {
            media = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: true })
          } catch (defaultVideoError) {
            console.warn('Could not start video capture; continuing as an audio-only call:', defaultVideoError)
            try {
              media = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false })
              setCameraEnabled(false)
              setLowDataTip('The camera could not start on this device. The call has connected with audio only; you can retry the camera.')
            } catch (audioError) {
              throw new Error(`Could not access the microphone after video capture failed: ${describeError(audioError)}`)
            }
          }
        }
      } else {
        media = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false })
      }
      if (disposedRef.current) {
        media.getTracks().forEach((track) => track.stop())
        return
      }
      localStreamRef.current = media
      setLocalStream(media)

      const peer = new RTCPeerConnection({
        iceServers,
        iceCandidatePoolSize: 2,
        bundlePolicy: 'max-bundle',
      })
      pcRef.current = peer
      for (const track of media.getTracks()) {
        const sender = peer.addTrack(track, media)
        if (track.kind === 'video') {
          videoSenderRef.current = sender
          const parameters = sender.getParameters()
          parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}]
          parameters.encodings[0].maxBitrate = 180_000
          parameters.encodings[0].maxFramerate = 12
          void sender.setParameters(parameters).catch((error: unknown) => console.warn('Could not apply low-data video settings:', error))
        }
      }
      if (callType === 'video' && !videoSenderRef.current) {
        videoSenderRef.current = peer.addTransceiver('video', { direction: 'sendrecv' }).sender
      }
      peer.ontrack = (event) => {
        const stream = event.streams[0] ?? new MediaStream([event.track])
        setRemoteStream(stream)
      }
      peer.onicecandidate = (event) => {
        if (event.candidate && !disposedRef.current) {
          void sendSignal('candidate', event.candidate.toJSON())
            .catch((error: unknown) => handleError('Network setup failed', error))
        }
      }
      peer.oniceconnectionstatechange = () => {
        if (disposedRef.current) return
        if (connectionTimerRef.current !== null) {
          window.clearTimeout(connectionTimerRef.current)
          connectionTimerRef.current = null
        }
        if (peer.iceConnectionState === 'connected' || peer.iceConnectionState === 'completed') {
          connectedAtRef.current = Date.now()
          setStatus(weakNetworkRef.current ? 'Connection is weak' : 'Connected')
        } else if (peer.iceConnectionState === 'checking' || peer.iceConnectionState === 'disconnected') {
          setStatus('Reconnecting…')
          connectionTimerRef.current = window.setTimeout(() => {
            if (disposedRef.current || peer.iceConnectionState === 'connected' || peer.iceConnectionState === 'completed') return
            setStatus('Call failed')
            setLowDataTip(turnAvailableRef.current
              ? 'The network could not establish or restore the peer connection.'
              : 'Direct connection failed. Configure an optional TURN relay in Supabase to support restrictive networks.')
          }, 12_000)
        } else if (peer.iceConnectionState === 'failed') {
          setStatus('Call failed')
          setLowDataTip(turnAvailableRef.current
            ? 'The network could not establish the peer connection.'
            : 'Direct connection failed. No TURN relay is configured, so this network may block the call.')
        }
      }
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === 'failed') {
          setStatus('Call failed')
          setLowDataTip(turnAvailableRef.current
            ? 'Peer connection failed. Check both devices’ network access.'
            : 'Peer connection failed. Add a TURN relay for networks that block direct connections.')
        }
      }

      if (session.status === 'accepted') setStatus('Connecting…')
      readyRef.current = true
      drainSignals()
      acceptedRef.current = acceptedRef.current || session.status === 'accepted'
      if (role === 'caller' && acceptedRef.current) await startOffer(peer)
      if (role === 'caller' && !acceptedRef.current && session.status === 'ringing') {
        ringTimerRef.current = window.setTimeout(() => {
          if (disposedRef.current || callStatusRef.current === 'Connected') return
          setLowDataTip('No answer yet. The call invitation will expire.')
          callbacksRef.current.onHangUp()
        }, Math.max(0, Date.parse(session.expires_at) - Date.now()))
      }

      const devices = await navigator.mediaDevices.enumerateDevices()
      if (!disposedRef.current) setAudioOutputs(devices.filter((device) => device.kind === 'audiooutput'))
      statsTimerRef.current = window.setInterval(() => {
        void (async () => {
        if (disposedRef.current || peer.connectionState !== 'connected') return
        const reports = await peer.getStats()
        let received = 0
        let lost = 0
        let roundTrip = 0
        reports.forEach((report) => {
          if (report.type === 'inbound-rtp' && (report.kind === 'video' || report.mediaType === 'video')) {
            received += report.packetsReceived ?? 0
            lost += report.packetsLost ?? 0
          }
          if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) {
            roundTrip = report.currentRoundTripTime ?? roundTrip
          }
        })
        const receivedDelta = Math.max(0, received - previousVideoStatsRef.current.received)
        const lostDelta = Math.max(0, lost - previousVideoStatsRef.current.lost)
        previousVideoStatsRef.current = { received, lost }
        const lossRatio = lostDelta / Math.max(receivedDelta + lostDelta, 1)
        const weak = lossRatio > 0.08 || roundTrip > 0.5
        weakNetworkRef.current = weak
        if (weak) {
          setStatus('Connection is weak')
          setLowDataTip('Network quality is low. Switch to audio-only to reduce data use.')
          const sender = videoSenderRef.current
          if (sender && sender.track) {
            const parameters = sender.getParameters()
            parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}]
            parameters.encodings[0].maxBitrate = 100_000
            await sender.setParameters(parameters).catch((error: unknown) => console.warn('Could not lower video bitrate:', error))
          }
        } else if (connectedAtRef.current && callStatusRef.current === 'Connection is weak') {
          setStatus('Connected')
          setLowDataTip('')
        }
        })().catch((error: unknown) => console.warn('Could not sample call network quality:', error))
      }, 3000)
    }

    const channel = supabase.channel(`peer-call:${callId}`, { config: { private: false } })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'call_signals', filter: `call_id=eq.${callId}` }, (payload) => {
        handleIncomingSignal(payload.new as Signal)
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'call_sessions', filter: `id=eq.${callId}` }, (payload) => {
        const update = payload.new as { status?: string }
        if (update.status === 'ended' || update.status === 'declined' || update.status === 'missed') {
          if (!handledRemoteEndRef.current) {
            handledRemoteEndRef.current = true
            if (update.status === 'declined' && role === 'caller') {
              setStatus('Call declined')
              setTerminalMessage(`${peerName} declined the call`)
              if (ringTimerRef.current !== null) window.clearTimeout(ringTimerRef.current)
              localStreamRef.current?.getTracks().forEach((track) => track.stop())
              pcRef.current?.close()
              setLocalStream(null)
              setRemoteStream(null)
              terminalTimerRef.current = window.setTimeout(() => callbacksRef.current.onRemoteEnd('declined'), 3000)
            } else {
              callbacksRef.current.onRemoteEnd(update.status)
            }
          }
          return
        }
        if (update.status === 'accepted') acceptedRef.current = true
        if (update.status === 'accepted' && role === 'caller' && readyRef.current && pcRef.current) {
          setStatus('Connecting…')
          if (ringTimerRef.current !== null) window.clearTimeout(ringTimerRef.current)
          void startOffer(pcRef.current)
        }
      })
      .subscribe((channelStatus) => {
        if (channelStatus === 'CHANNEL_ERROR' || channelStatus === 'TIMED_OUT') {
          handleError('Call signaling unavailable', new Error('Supabase Realtime could not connect. Check network access and retry.'))
          return
        }
        if (channelStatus !== 'SUBSCRIBED') return
        void (async () => {
          const { data: signals, error: signalError } = await supabase
            .from('call_signals')
            .select('id,call_id,from_user,signal_type,payload')
            .eq('call_id', callId)
            .order('created_at', { ascending: true })
          if (signalError) throw new Error(`Unable to load call signaling: ${signalError.message}`)
          for (const signal of (signals ?? []) as Signal[]) handleIncomingSignal(signal)
          await initialize()
        })().catch((error: unknown) => handleError('Could not join the call', error))
      })
    channelRef.current = channel

    return () => {
      disposedRef.current = true
      if (ringTimerRef.current !== null) window.clearTimeout(ringTimerRef.current)
      if (connectionTimerRef.current !== null) window.clearTimeout(connectionTimerRef.current)
      if (statsTimerRef.current !== null) window.clearInterval(statsTimerRef.current)
      if (terminalTimerRef.current !== null) window.clearTimeout(terminalTimerRef.current)
      if (channelRef.current) void supabase.removeChannel(channelRef.current)
      const peer = pcRef.current
      if (peer) {
        peer.ontrack = null
        peer.onicecandidate = null
        peer.oniceconnectionstatechange = null
        peer.onconnectionstatechange = null
        peer.close()
      }
      localStreamRef.current?.getTracks().forEach((track) => track.stop())
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null
      if (localVideoRef.current) localVideoRef.current.srcObject = null
      pcRef.current = null
      videoSenderRef.current = null
      localStreamRef.current = null
    }
  }, [callId, callType, role, supabase, userId])

  useEffect(() => {
    if (localVideoRef.current && localStream) localVideoRef.current.srcObject = localStream
  }, [localStream])

  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) remoteVideoRef.current.srcObject = remoteStream
  }, [remoteStream])

  async function toggleCamera() {
    const sender = videoSenderRef.current
    if (!sender) return
    const currentTrack = sender.track
    if (!currentTrack) {
      try {
        const camera = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 320, max: 320 }, height: { ideal: 240, max: 240 }, frameRate: { ideal: 12, max: 15 } },
        })
        const track = camera.getVideoTracks()[0]
        if (!track) throw new Error('No camera is available.')
        await sender.replaceTrack(track)
        localStreamRef.current?.addTrack(track)
        setLocalStream(localStreamRef.current)
        videoSenderRef.current = sender
        setCameraEnabled(true)
      } catch (error) {
        callbacksRef.current.onError(`Camera could not start: ${describeError(error)}`)
      }
      return
    }
    currentTrack.stop()
    await sender.replaceTrack(null)
    localStreamRef.current?.removeTrack(currentTrack)
    setLocalStream(localStreamRef.current)
    setCameraEnabled(false)
  }

  function toggleMicrophone() {
    const track = localStreamRef.current?.getAudioTracks()[0]
    if (!track) return
    track.enabled = !track.enabled
    setMuted(!track.enabled)
  }

  async function switchToAudioOnly() {
    const sender = videoSenderRef.current
    if (!sender?.track) return
    const track = sender.track
    track.stop()
    await sender.replaceTrack(null)
    localStreamRef.current?.removeTrack(track)
    setLocalStream(localStreamRef.current)
    setCameraEnabled(false)
    setLowDataTip('Video is off. Your microphone remains active.')
  }

  async function changeAudioOutput(deviceId: string) {
    setAudioOutput(deviceId)
    const video = remoteVideoRef.current as (HTMLVideoElement & { setSinkId?: (sinkId: string) => Promise<void> }) | null
    if (!video?.setSinkId) {
      setLowDataTip('This device does not support selecting an audio output; using the system default.')
      return
    }
    try {
      await video.setSinkId(deviceId)
    } catch (error) {
      callbacksRef.current.onError(`Could not change audio output: ${describeError(error)}`)
    }
  }

  return <section className={`call-layer ${terminalMessage ? 'call-terminal-layer' : ''}`} role="dialog" aria-modal="true" aria-label={`${callType} call`}>
    {terminalMessage ? <div className="call-terminal-message" role="status">
      <span>{callType === 'audio' ? 'Voice call' : 'Video call'}</span>
      <strong>{terminalMessage}</strong>
      <small>Returning to the conversation…</small>
    </div> : <>
    <header className="call-toolbar">
      <div><strong>{callType === 'audio' ? 'Voice call' : 'Video call'}</strong><span className={`call-status ${status === 'Connected' ? 'connected' : status === 'Call failed' ? 'failed' : ''}`}>{status}</span></div>
      <span className="call-peer-name">{peerName}</span>
      <button className="call-end" onClick={onHangUp}>End call</button>
    </header>
    <div className={`peer-call-stage ${callType === 'audio' ? 'audio-only' : ''}`}>
      <video ref={remoteVideoRef} autoPlay playsInline className="peer-remote-video" />
      {callType === 'audio' && <div className="peer-audio-avatar">{peerName.slice(0, 1).toUpperCase()}</div>}
      {callType === 'video' && cameraEnabled && <video ref={localVideoRef} autoPlay muted playsInline className="peer-local-video" />}
      {!turnAvailable && <div className="peer-network-note">Direct connection mode · Calls may not work behind restrictive networks without TURN.</div>}
    </div>
    <div className="peer-call-controls">
      <button onClick={toggleMicrophone}>{muted ? 'Unmute microphone' : 'Mute microphone'}</button>
      {callType === 'video' && <button onClick={() => void toggleCamera()}>{cameraEnabled ? 'Turn camera off' : 'Turn camera on'}</button>}
      {audioOutputs.length > 1 && <label className="peer-output-select">Audio output
        <select value={audioOutput} onChange={(event) => void changeAudioOutput(event.target.value)}>
          {audioOutputs.map((device, index) => <option key={device.deviceId || index} value={device.deviceId}>{device.label || `Output ${index + 1}`}</option>)}
        </select>
      </label>}
      {callType === 'video' && cameraEnabled && <button onClick={() => void switchToAudioOnly()}>Switch to audio-only</button>}
    </div>
    {lowDataTip && <p className="peer-call-tip" role="status">{lowDataTip}</p>}
    </>}
  </section>
}

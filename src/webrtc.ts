/**
 * WebRTC primitives for peer-to-peer connections.
 *
 * In the star topology:
 *   - Joiner calls createOffer() → produces offer string
 *   - Host calls acceptOffer() → produces answer string
 *   - Joiner calls acceptAnswer() → connection complete
 *
 * The data channel carries binary yjs updates (Uint8Array).
 */

export type OnBinaryMessage = (data: Uint8Array) => void;
export type OnOpen = () => void;
export type OnClose = () => void;

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

// ---------------------------------------------------------------------------
// Joiner: create offer (initiates connection + data channel)
// ---------------------------------------------------------------------------

export async function createOffer(
  onMessage: OnBinaryMessage,
  onOpen: OnOpen,
  onClose: OnClose,
): Promise<{ pc: RTCPeerConnection; dc: RTCDataChannel; offerString: string }> {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const candidates: RTCIceCandidateInit[] = [];

  const dc = pc.createDataChannel("yjs", { ordered: true });
  dc.binaryType = "arraybuffer";
  setupDataChannel(dc, onMessage, onOpen, onClose);

  pc.onicecandidate = (e) => {
    if (e.candidate) candidates.push(e.candidate.toJSON());
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitForIceGathering(pc);

  const blob = { sdp: pc.localDescription!.toJSON(), candidates };
  return { pc, dc, offerString: encode(blob) };
}

// ---------------------------------------------------------------------------
// Host: accept offer → produce answer (receives data channel)
// ---------------------------------------------------------------------------

export async function acceptOffer(
  offerString: string,
  onMessage: OnBinaryMessage,
  onOpen: OnOpen,
  onClose: OnClose,
): Promise<{
  pc: RTCPeerConnection;
  dc: Promise<RTCDataChannel>;
  answerString: string;
}> {
  const { sdp: remoteSdp, candidates: remoteCandidates } = decode(offerString);
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const localCandidates: RTCIceCandidateInit[] = [];

  const dcPromise = new Promise<RTCDataChannel>((resolve) => {
    pc.ondatachannel = (e) => {
      e.channel.binaryType = "arraybuffer";
      setupDataChannel(e.channel, onMessage, onOpen, onClose);
      resolve(e.channel);
    };
  });

  pc.onicecandidate = (e) => {
    if (e.candidate) localCandidates.push(e.candidate.toJSON());
  };

  await pc.setRemoteDescription(remoteSdp);
  for (const c of remoteCandidates) await pc.addIceCandidate(c);

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await waitForIceGathering(pc);

  const blob = {
    sdp: pc.localDescription!.toJSON(),
    candidates: localCandidates,
  };
  return { pc, dc: dcPromise, answerString: encode(blob) };
}

// ---------------------------------------------------------------------------
// Joiner: complete connection with host's answer
// ---------------------------------------------------------------------------

export async function acceptAnswer(
  pc: RTCPeerConnection,
  answerString: string,
) {
  const { sdp, candidates } = decode(answerString);
  await pc.setRemoteDescription(sdp);
  for (const c of candidates) await pc.addIceCandidate(c);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SignalBlob {
  sdp: RTCSessionDescriptionInit;
  candidates: RTCIceCandidateInit[];
}

export function encode(blob: SignalBlob): string {
  return btoa(JSON.stringify(blob));
}

export function decode(str: string): SignalBlob {
  try {
    return JSON.parse(atob(str)) as SignalBlob;
  } catch {
    throw new Error("Invalid signaling data");
  }
}

function setupDataChannel(
  dc: RTCDataChannel,
  onMessage: OnBinaryMessage,
  onOpen: OnOpen,
  onClose: OnClose,
) {
  dc.onopen = () => onOpen();
  dc.onclose = () => onClose();
  dc.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) {
      onMessage(new Uint8Array(e.data));
    }
  };
}

function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", check);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", check);
    setTimeout(() => {
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    }, 3000);
  });
}

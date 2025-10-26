import { RTCPeerConnection, RTCIceCandidate, RTCSessionDescription } from 'react-native-webrtc';
import get from 'lodash/get';
import last from 'lodash/last';
import sdp from 'sdp-transform';

import DataChannel from '../data-channel';
import { SocketEvents } from '../constants';

class PeerConnection {
  constructor(clientId, socket, config, callbacks) {
    this.clientId = clientId;
    this._socket = socket;
    this._config = config;
    this._connection = null;
    this._callbacks = callbacks;
    this._dataChannels = {};
    this._candidateQueue = [];
    this._nextTrackId = null;

    this._connect();
    if (clientId) this._setSocketListeners();
  }

  addTrack(track, stream, trackId) {
    this._nextTrackId = trackId;
    return this._connection.addTrack(track, stream);
  }

  removeTrack(sender) {
    this._connection.removeTrack(sender);
  }

  open(channel) {
    if (this._dataChannels[channel] && this._dataChannels[channel]._open) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const callbacks = {
        onmessage: (ch, data) => this._onDataMessage(ch, data),
        onopen: resolve,
      };
      this._dataChannels[channel] = new DataChannel(
        channel,
        this._connection,
        callbacks
      );
    });
  }

  send(channel, data) {
    const dc = this._dataChannels[channel];

    if (dc) dc.send(data);
  }

  getSenders() {
    return this._connection.getSenders();
  }

  dispose() {
    Object.values(this._dataChannels).forEach((dc) => dc.close());

    this._connection.close();
    this._connection = null;
    this._candidateQueue = [];

    if (this._callbacks && this._callbacks.onClose) {
      this._callbacks.onClose({ clientId: this.clientId });
    }
  }

  _connect() {
    this._connection = new RTCPeerConnection(this._config);

    this._connection.onicecandidate = this._onIceCandidate;
    this._connection.ontrack = this._onTrack;
    this._connection.onnegotiationneeded = this._onNegotiationNeeded;

    this._connection.ondatachannel = ({ channel }) => {
      const callbacks = {
        onmessage: (ch, data) => this._onDataMessage(ch, data),
      };

      this._dataChannels[channel.label] = new DataChannel(
        channel.label,
        this._connection,
        callbacks,
        channel
      );
    };
  }

  createDataChannels(labels = []) {
    labels.forEach((label) => {
      const callbacks = {
        onmessage: (ch, data) => this._onDataMessage(ch, data),
      };

      this._dataChannels[label] = new DataChannel(
        label,
        this._connection,
        callbacks
      );
    });
  }

  _setSocketListeners() {
    this._socket.on(SocketEvents.PEER_ICE_CANDIDATE, this._receiveIceCandidate);
    this._socket.on(SocketEvents.PEER_MEDIA_OFFER, this._receiveOffer);
    this._socket.on(SocketEvents.PEER_MEDIA_ANSWER, this._receiveAnswer);
  }

  _receiveIceCandidate = (data) => {
    if (data.clientId !== this.clientId) return;
    const iceCandidate = new RTCIceCandidate(data.candidate);

    // If no remote description yet, queue the candidate
    if (!this._connection.remoteDescription) {
      this.pushCandidateQueue(iceCandidate);
      return;
    }

    this._connection.addIceCandidate(iceCandidate);
  };

  _receiveOffer = (data) => {
    if (data.clientId !== this.clientId) return;
    const desc = new RTCSessionDescription(data.sdp);

    this._connection
      .setRemoteDescription(desc)
      .then(() => this._connection.createAnswer())
      .then((answer) => this._connection.setLocalDescription(answer))
      .then(() => {
        this._socket.emit(SocketEvents.PEER_MEDIA_ANSWER, {
          peerClientId: this.clientId,
          sdp: this._connection.localDescription,
        });
      });
  };

  _receiveAnswer = (data) => {
    if (data.clientId !== this.clientId) return;
    const desc = new RTCSessionDescription(data.sdp);

    if (this._connection) {
      this._connection
        .setRemoteDescription(desc)
        .then(() => this.addCandidateQueue())
        .then(() => this.clearCandidateQueue());
    }
  };

  _onIceCandidate = ({ candidate }) => {
    if (candidate) {
      this._socket.emit(SocketEvents.PEER_ICE_CANDIDATE, {
        peerClientId: this.clientId,
        candidate,
      });
    }
  };

  _onTrack = (event) => {
    const stream = event.streams[0];
    const remoteDescription = get(event, ['target', 'remoteDescription']);
    const parsed = sdp.parse(remoteDescription.sdp);
    const audio = parsed.media.filter((m) => m.type === 'audio');
    const media = last(audio);
    const uri = get(last(media.ext), 'uri');
    const trackId = uri.split('/track/').pop();

    if (this._callbacks && this._callbacks.onAddTrack) {
      this._callbacks.onAddTrack({
        clientId: this.clientId,
        trackId,
        stream
      });
    }

    if (this._callbacks && this._callbacks.onRemoveTrack) {
      stream.onremovetrack = () => {
        this._callbacks.onRemoveTrack({
          clientId: this.clientId,
          trackId,
          stream
        });
      };
    }
  };

  _onNegotiationNeeded = () => {
    this._connection].createOffer()
      .then((offer) => {
        const parsed = sdp.parse(offer.sdp);
        const audio = parsed.media.filter((m) => m.type === 'audio');
        const media = last(audio);

        if (this._nextTrackId && media.ext) {

          /**
           * WebRTC doesn't have any way to consistently
           * identify tracks between a sender and receiver,
           * so we have to modify the sdp and embed our own identifier.
           *
           * See: https://www.kevinmoreland.com/articles/03-22-20-webrtc-mediastream-tracks
           */
          media.ext.push({
            value: media.ext.length + 1,
            uri: `meshy/track/${this._nextTrackId}`
          });
        }

        // eslint-disable-next-line
        offer.sdp = sdp.write(parsed);

        return offer;
      })
      .then((offer) => this._connection.setLocalDescription(offer))
      .then(() => {
        this._socket.emit(SocketEvents.PEER_MEDIA_OFFER, {
          peerClientId: this.clientId,
          sdp: this._connection.localDescription,
        });
      });
  };

  _onDataMessage = (channel, _data) => {
    const data = { peerId: this.clientId, channel, ..._data };
    if (this._callbacks && this._callbacks.onDataMessage) {
      this._callbacks.onDataMessage(data);
    }
  };

  pushCandidateQueue(candidate) {
    this._candidateQueue.push(candidate);
  }

  addCandidateQueue() {
    return Promise.all(
      this._candidateQueue.map((c) => this._connection.addIceCandidate(c))
    );
  }

  clearCandidateQueue() {
    this._candidateQueue = [];
  }
}

export default PeerConnection;

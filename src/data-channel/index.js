class DataChannel {
  constructor(label, connection, callbacks, channel) {
    // If a channel is passed (from ondatachannel), use it; otherwise create one
    this._channel = channel || connection.createDataChannel(label);
    this._open = false;

    this._channel.onopen = () => {
      this._open = true;
      if (callbacks.onopen) {
        callbacks.onopen();
      }
    };

    this._channel.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        callbacks.onmessage(label, parsed);
      } catch (e) {
        // Fallback if non‑JSON data is sent
        callbacks.onmessage(label, { raw: event.data });
      }
    };

    this._channel.onclose = () => {
      this._open = false;
    };

    this._channel.onerror = (err) => {
      console.warn(`[DataChannel:${label}] error`, err);
    };
  }

  send(data = {}) {
    const transactionId = Math.floor(Math.random() * 1e6);
    const payload = JSON.stringify({
      transactionId,
      ...data,
    });

    if (this._open) {
      this._channel.send(payload);
    } else {
      console.warn(`[DataChannel:${this._channel.label}] not open, dropping`, payload);
    }
  }

  close() {
    if (this._open) {
      this._channel.close();
      this._open = false;
    }
  }
}

export default DataChannel;

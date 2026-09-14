(()=>{
  if (window.__matrixVoiceInstalled) return;
  window.__matrixVoiceInstalled = true;

  const SESSION_KEY = "matrix_voice_session_v1";
  const sessionId = (() => {
    try {
      let id = localStorage.getItem(SESSION_KEY);
      if (!id) {
        id = (crypto?.randomUUID?.() || `s-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        localStorage.setItem(SESSION_KEY, id);
      }
      return id;
    } catch {
      return `s-${Date.now()}`;
    }
  })();

  const style = document.createElement("style");
  style.textContent = `
    #matrixVoiceDock{position:fixed;right:18px;bottom:18px;z-index:99999;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;align-items:flex-end;gap:10px}
    #matrixVoiceButton{border:0;border-radius:999px;padding:12px 17px;background:#111827;color:#fff;font-weight:800;box-shadow:0 10px 30px rgba(0,0,0,.28);cursor:pointer;display:flex;gap:8px;align-items:center}
    #matrixVoiceButton.recording{background:#991b1b;animation:matrixPulse 1.2s infinite}
    #matrixVoiceButton.busy{opacity:.72;cursor:wait}
    #matrixVoicePanel{display:none;width:min(390px,calc(100vw - 36px));background:#fff;color:#111827;border:1px solid #e5e7eb;border-radius:16px;box-shadow:0 16px 45px rgba(0,0,0,.24);padding:14px}
    #matrixVoicePanel.open{display:block}
    #matrixVoiceStatus{font-size:12px;color:#6b7280;margin-bottom:7px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
    #matrixVoiceTranscript{font-size:14px;color:#374151;margin-bottom:8px;white-space:pre-wrap}
    #matrixVoiceAnswer{font-size:15px;line-height:1.42;font-weight:650;white-space:pre-wrap}
    #matrixVoiceClose{float:right;border:0;background:transparent;font-size:18px;cursor:pointer;color:#6b7280}
    @keyframes matrixPulse{0%,100%{transform:scale(1)}50%{transform:scale(1.04)}}
  `;
  document.head.appendChild(style);

  const dock = document.createElement("div");
  dock.id = "matrixVoiceDock";
  dock.innerHTML = `
    <div id="matrixVoicePanel">
      <button id="matrixVoiceClose" title="Fechar">×</button>
      <div id="matrixVoiceStatus">Matrix</div>
      <div id="matrixVoiceTranscript"></div>
      <div id="matrixVoiceAnswer">Toque em “Matrix • Voz” e fale seu comando.</div>
    </div>
    <button id="matrixVoiceButton" type="button" title="Falar com o Matrix"><span>🎙️</span><span>Matrix • Voz</span></button>
  `;
  document.body.appendChild(dock);

  const button = document.getElementById("matrixVoiceButton");
  const panel = document.getElementById("matrixVoicePanel");
  const status = document.getElementById("matrixVoiceStatus");
  const transcript = document.getElementById("matrixVoiceTranscript");
  const answer = document.getElementById("matrixVoiceAnswer");
  document.getElementById("matrixVoiceClose").onclick = () => panel.classList.remove("open");

  let recorder = null;
  let stream = null;
  let chunks = [];
  let timer = null;

  function setState(label, state="") {
    status.textContent = label;
    button.classList.remove("recording", "busy");
    if (state) button.classList.add(state);
  }

  function speak(text) {
    try {
      if (!window.speechSynthesis || !text) return;
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(String(text));
      u.lang = "pt-BR";
      u.rate = 1.02;
      const voices = speechSynthesis.getVoices?.() || [];
      const pt = voices.find(v => /^pt-BR/i.test(v.lang)) || voices.find(v => /^pt/i.test(v.lang));
      if (pt) u.voice = pt;
      speechSynthesis.speak(u);
    } catch {}
  }

  async function blobToBase64(blob) {
    const arrayBuffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = "";
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
      binary += String.fromCharCode(...bytes.subarray(i, i + step));
    }
    return btoa(binary);
  }

  async function sendAudio(blob) {
    panel.classList.add("open");
    transcript.textContent = "";
    answer.textContent = "Processando seu comando…";
    setState("Processando", "busy");

    try {
      const audioBase64 = await blobToBase64(blob);
      const response = await fetch("/matrix/command/audio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audio_base64: audioBase64,
          mime_type: blob.type || "audio/webm",
          session_id: sessionId,
          page: location.pathname
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.mensagem || data?.answer || "Falha no comando");
      transcript.textContent = data.transcript ? `Você: ${data.transcript}` : "";
      answer.textContent = data.answer || data.mensagem || "Comando concluído.";
      setState(data.requires_confirmation ? "Confirmação necessária" : "Matrix respondeu");
      speak(answer.textContent);
    } catch (error) {
      answer.textContent = error.message || "Não consegui processar o comando.";
      setState("Erro");
    }
  }

  async function stopRecording() {
    if (!recorder || recorder.state === "inactive") return;
    clearTimeout(timer);
    recorder.stop();
  }

  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      const typed = prompt("Seu navegador não liberou gravação de voz aqui. Digite o comando do Matrix:");
      if (!typed) return;
      panel.classList.add("open");
      setState("Processando", "busy");
      try {
        const response = await fetch("/matrix/command", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: typed, source: "web_text", session_id: sessionId, page: location.pathname })
        });
        const data = await response.json();
        transcript.textContent = `Você: ${typed}`;
        answer.textContent = data.answer || data.mensagem || "Comando concluído.";
        setState("Matrix respondeu");
        speak(answer.textContent);
      } catch (error) {
        answer.textContent = error.message || "Falha no comando.";
        setState("Erro");
      }
      return;
    }

    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    const preferred = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm"]
      .find(type => MediaRecorder.isTypeSupported?.(type));
    recorder = preferred ? new MediaRecorder(stream, { mimeType: preferred }) : new MediaRecorder(stream);
    recorder.ondataavailable = event => { if (event.data?.size) chunks.push(event.data); };
    recorder.onstop = async () => {
      try {
        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        stream?.getTracks?.().forEach(track => track.stop());
        stream = null;
        recorder = null;
        if (!blob.size) throw new Error("A gravação ficou vazia.");
        await sendAudio(blob);
      } catch (error) {
        panel.classList.add("open");
        answer.textContent = error.message || "Não consegui enviar o áudio.";
        setState("Erro");
      }
    };
    recorder.start();
    panel.classList.add("open");
    transcript.textContent = "Fale normalmente. Ex.: “Matrix, quantas memórias DDR3 de 8 GB Kingston temos?”";
    answer.textContent = "Toque novamente para enviar. Eu também envio sozinho em até 10 segundos.";
    setState("Ouvindo…", "recording");
    timer = setTimeout(stopRecording, 10000);
  }

  button.onclick = async () => {
    if (button.classList.contains("busy")) return;
    try {
      if (recorder && recorder.state === "recording") await stopRecording();
      else await startRecording();
    } catch (error) {
      panel.classList.add("open");
      answer.textContent = error?.message?.includes("Permission") || error?.name === "NotAllowedError"
        ? "O navegador bloqueou o microfone. Libere a permissão do site e tente novamente."
        : (error.message || "Não consegui abrir o microfone.");
      setState("Microfone indisponível");
    }
  };
})();

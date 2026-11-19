// ============ ФРАЗЫ (голос Саши): текст и файл ============
const PHRASES = [
  { text: "Котик, ты сегодня невероятная", src: "audio/01.m4a" },
  { text: "Белочка моя, какая же ты красивая", src: "audio/02.m4a" },
  { text: "Карен, ты самая красивая", src: "audio/03.m4a" },
  { text: "Кариночка, ты просто чудо", src: "audio/04.m4a" },
  { text: "Любовь моя, ты прекрасна", src: "audio/05.m4a" },
  { text: "Ты такая модельная!", src: "audio/06.m4a" },
  { text: "Да ты самая красивая", src: "audio/07.m4a" },
  { text: "Ну какая же красотка", src: "audio/08.m4a" },
  { text: "Котик, эти глаза сводят меня с ума", src: "audio/09.m4a" },
  { text: "Кариночка, тебе всё идёт", src: "audio/10.m4a" },
  { text: "Любовь моя, я тебя обожаю", src: "audio/11.m4a" },
  { text: "Белочка, ты сегодня огонь", src: "audio/12.m4a" },
  { text: "Вот это девушка, вот это красота", src: "audio/13.m4a" },
  { text: "Карен, обложка журнала отдыхает", src: "audio/14.m4a" },
  { text: "Я самый счастливый, потому что ты моя", src: "audio/15.m4a" },
  { text: "Котик, не смотри так, я влюбляюсь ещё сильнее", src: "audio/16.m4a" },
];
// Фразы, когда она улыбается
const SMILE_PHRASES = [
  { text: "Вот эта улыбка самая лучшая", src: "audio/17.m4a" },
  { text: "Кариночка, улыбайся чаще, ты сияешь", src: "audio/18.m4a" },
];
// ==========================================================

import { FaceLandmarker, FilesetResolver } from "./vendor/vision_bundle.mjs";

const SPEECH_LANG = "ru-RU";
const ABSENT_BEFORE_GREET_MS = 3000; // сколько нет лица, чтобы считать, что она «подошла» заново
const REPEAT_WHILE_LOOKING_MS = 9000; // не чаще, пока она смотрит
const FACE_STABLE_MS = 600;
const SMILE_THRESHOLD = 0.55;
const SMILE_HOLD_MS = 400;
const SMILE_COOLDOWN_MS = 20000;
const DETECT_INTERVAL_MS = 100;

const $ = (id) => document.getElementById(id);
const video = $("video"), phraseEl = $("phrase"), statusEl = $("status");
const startScreen = $("start-screen"), errorScreen = $("error-screen"), heartBtn = $("heart-btn");

let stream = null, landmarker = null, running = false, rafId = 0;
let lastPhrase = "", lastSpeakAt = 0, lastSmileAt = -Infinity;
let faceSince = 0, lastFaceAt = 0, hadFace = false, smileSince = 0, lastDetect = 0;
let hideTimer = 0, absentAtAppear = Infinity, greeted = false;

// ---- аудио: один общий плеер, «разбуженный» касанием (требование iOS) ----
const player = new Audio();
player.preload = "auto";
const SILENT_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";
const blobUrls = new Map();
let audioUnlocked = false, playToken = 0;
let ruVoice = null;

function pickVoice() {
  const voices = speechSynthesis.getVoices().filter((v) => v.lang && v.lang.toLowerCase().replace("_", "-").startsWith("ru"));
  ruVoice = voices.find((v) => /milena|katya|alena|irina|anna|female|женск/i.test(v.name)) || voices.find((v) => v.default) || voices[0] || null;
}
if ("speechSynthesis" in window) {
  pickVoice();
  speechSynthesis.addEventListener?.("voiceschanged", pickVoice);
}

async function preloadClips() {
  for (const p of [...PHRASES, ...SMILE_PHRASES]) {
    if (blobUrls.has(p.src)) continue;
    try {
      const r = await fetch(p.src);
      if (r.ok) blobUrls.set(p.src, URL.createObjectURL(await r.blob()));
    } catch (e) { /* возьмём по ссылке при воспроизведении */ }
  }
}

function setStatus(t) { statusEl.textContent = t || ""; }

function show(text) {
  phraseEl.textContent = text;
  phraseEl.classList.add("show");
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => phraseEl.classList.remove("show"), 6500);
}

function speakFallback(text) {
  if (!("speechSynthesis" in window)) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = SPEECH_LANG;
    if (ruVoice) u.voice = ruVoice;
    u.rate = 0.95; u.pitch = 1.1; u.volume = 1;
    speechSynthesis.speak(u);
  } catch (e) { /* текст на экране всё равно виден */ }
}

function playClip(p) {
  try {
    player.pause();
    const token = ++playToken;
    player.onerror = () => { if (token === playToken) speakFallback(p.text); };
    player.src = blobUrls.get(p.src) || p.src;
    player.currentTime = 0;
    const pr = player.play();
    if (pr && pr.catch) pr.catch((err) => { if (token === playToken && !(err && err.name === "AbortError")) speakFallback(p.text); });
  } catch (e) { speakFallback(p.text); }
}

function isSpeaking() {
  return (!player.paused && !player.ended) || ("speechSynthesis" in window && speechSynthesis.speaking);
}

function sayFrom(list) {
  let pool = list.filter((p) => p.text !== lastPhrase);
  if (!pool.length) pool = list;
  const p = pool[Math.floor(Math.random() * pool.length)];
  lastPhrase = p.text;
  lastSpeakAt = performance.now();
  show(p.text);
  playClip(p);
}

function unlockAudio() {
  // iOS разрешает звук только после касания: «прогреваем» общий плеер тишиной
  if (audioUnlocked) return;
  try {
    player.src = SILENT_WAV;
    const pr = player.play();
    if (pr && pr.then) pr.then(() => { audioUnlocked = true; }).catch(() => {});
    else audioUnlocked = true;
  } catch (e) {}
}

function showError(title, text) {
  stopCamera();
  $("error-title").textContent = title;
  $("error-text").textContent = text;
  startScreen.hidden = true; heartBtn.hidden = true; errorScreen.hidden = false;
  setStatus("");
}

async function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw Object.assign(new Error("nomedia"), { name: "NoMediaError" });
  }
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play().catch(() => {});
}

function stopCamera() {
  running = false;
  cancelAnimationFrame(rafId);
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  video.srcObject = null;
}

async function loadLandmarker() {
  if (landmarker) return landmarker;
  const fileset = await FilesetResolver.forVisionTasks("./vendor");
  const make = (delegate) => FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: "./vendor/face_landmarker.task", delegate },
    runningMode: "VIDEO",
    numFaces: 1,
    outputFaceBlendshapes: true,
  });
  try { landmarker = await make("GPU"); }
  catch (e) { landmarker = await make("CPU"); }
  return landmarker;
}

function loop() {
  if (!running) return;
  rafId = requestAnimationFrame(loop);
  const now = performance.now();
  if (now - lastDetect < DETECT_INTERVAL_MS || video.readyState < 2 || !video.videoWidth) return;
  lastDetect = now;

  let res;
  try { res = landmarker.detectForVideo(video, now); } catch (e) { return; }
  const face = res && res.faceLandmarks && res.faceLandmarks.length > 0;

  if (face) {
    if (!hadFace) {
      faceSince = now;
      absentAtAppear = lastFaceAt ? now - lastFaceAt : Infinity;
      greeted = false;
    }
    hadFace = true;
    lastFaceAt = now;
    setStatus("");

    const stable = now - faceSince >= FACE_STABLE_MS;
    const quiet = !isSpeaking() && now - lastSpeakAt > 2500;

    // улыбка
    let smile = 0;
    const bs = res.faceBlendshapes && res.faceBlendshapes[0] && res.faceBlendshapes[0].categories;
    if (bs) {
      const l = bs.find((c) => c.categoryName === "mouthSmileLeft");
      const r = bs.find((c) => c.categoryName === "mouthSmileRight");
      if (l && r) smile = (l.score + r.score) / 2;
    }
    if (smile > SMILE_THRESHOLD) { if (!smileSince) smileSince = now; } else { smileSince = 0; }

    if (stable && quiet) {
      if (smileSince && now - smileSince >= SMILE_HOLD_MS && now - lastSmileAt > SMILE_COOLDOWN_MS) {
        lastSmileAt = now;
        sayFrom(SMILE_PHRASES);
      } else if (!greeted && absentAtAppear >= ABSENT_BEFORE_GREET_MS) {
        greeted = true;
        sayFrom(PHRASES);
      } else if (now - lastSpeakAt > REPEAT_WHILE_LOOKING_MS) {
        sayFrom(PHRASES);
      }
    }
  } else {
    if (hadFace && now - lastFaceAt > 800) { hadFace = false; smileSince = 0; }
    if (!hadFace && now - lastFaceAt > 1500) setStatus("Посмотри в зеркальце");
  }
}

async function begin() {
  errorScreen.hidden = true;
  unlockAudio();
  preloadClips();
  startScreen.hidden = true;
  setStatus("Включаю зеркальце…");
  try {
    await startCamera();
  } catch (e) {
    const n = e && e.name;
    if (n === "NotAllowedError" || n === "SecurityError" || n === "PermissionDeniedError") {
      showError("Зеркальцу нужна камера", "Разреши доступ к камере: Настройки iPhone → Safari → Камера → Разрешить (или нажми «аA» в адресной строке → Настройки веб-сайта). Потом нажми кнопку ниже.");
    } else if (n === "NotFoundError" || n === "OverconstrainedError") {
      showError("Не нашла камеру", "Похоже, фронтальная камера недоступна. Проверь, что её не использует другое приложение.");
    } else if (n === "NoMediaError") {
      showError("Откроется только в Safari", "Открой ссылку в Safari на iPhone, тогда зеркальце заработает.");
    } else {
      showError("Зеркальце не включилось", "Не получилось запустить камеру. Попробуй ещё раз.");
    }
    return;
  }

  heartBtn.hidden = false;
  setStatus("Зеркальце просыпается…");
  try {
    await loadLandmarker();
  } catch (e) {
    console.error(e);
    setStatus("Лицо распознать не получилось, но сердечко внизу работает");
    return;
  }
  setStatus("");
  running = true;
  lastFaceAt = 0; hadFace = false; lastSpeakAt = 0; greeted = false;
  loop();
}

$("start-btn").addEventListener("click", begin);
$("retry-btn").addEventListener("click", begin);
heartBtn.addEventListener("click", () => {
  unlockAudio();
  heartBtn.classList.add("beat");
  setTimeout(() => heartBtn.classList.remove("beat"), 300);
  sayFrom(PHRASES);
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopCamera();
    player.pause();
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    if (!errorScreen.hidden) return;
    heartBtn.hidden = true; startScreen.hidden = false; setStatus("");
    phraseEl.classList.remove("show");
  }
});

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

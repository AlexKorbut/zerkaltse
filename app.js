// ============ ФРАЗЫ: меняй здесь ============
const PHRASES = [
  "Да ты самая красивая",
  "Ну какая же ты красотка",
  "Улыбнись, тебе очень идёт",
  "Саша тебя очень любит",
  "Ты сегодня просто сияешь",
  "Какие у тебя красивые глаза",
  "Ты невероятная",
  "С тобой любой день становится лучше",
  "Ты моё любимое чудо",
  "Ты красивая и снаружи, и внутри",
  "Какая же ты милая",
  "Тебе так идёт быть собой",
  "Ты делаешь мир теплее",
  "Саша от тебя без ума",
  "Ты прекрасна, и это не обсуждается",
  "Ты очень-очень любимая",
];
// Фраза, когда она улыбается
const SMILE_PHRASES = ["Вот эта улыбка самая лучшая"];
// ============================================

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
let ruVoice = null, hideTimer = 0, absentAtAppear = Infinity, greeted = false;

function pickVoice() {
  const voices = speechSynthesis.getVoices().filter((v) => v.lang && v.lang.toLowerCase().replace("_", "-").startsWith("ru"));
  if (!voices.length) { ruVoice = null; return; }
  const female = voices.find((v) => /milena|katya|alena|irina|anna|female|женск/i.test(v.name));
  ruVoice = female || voices.find((v) => v.default) || voices[0];
}
if ("speechSynthesis" in window) {
  pickVoice();
  speechSynthesis.addEventListener?.("voiceschanged", pickVoice);
}

function setStatus(t) { statusEl.textContent = t || ""; }

function show(text) {
  phraseEl.textContent = text;
  phraseEl.classList.add("show");
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => phraseEl.classList.remove("show"), 6500);
}

function speak(text) {
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

function isSpeaking() { return "speechSynthesis" in window && speechSynthesis.speaking; }

function sayFrom(list) {
  let pool = list.filter((p) => p !== lastPhrase);
  if (!pool.length) pool = list;
  const text = pool[Math.floor(Math.random() * pool.length)];
  lastPhrase = text;
  lastSpeakAt = performance.now();
  show(text);
  speak(text);
}

function unlockSpeech() {
  // iOS разрешает речь только после касания: «прогреваем» тихим произнесением
  if (!("speechSynthesis" in window)) return;
  try {
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0; u.lang = SPEECH_LANG;
    speechSynthesis.speak(u);
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
  unlockSpeech();
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
  unlockSpeech();
  heartBtn.classList.add("beat");
  setTimeout(() => heartBtn.classList.remove("beat"), 300);
  sayFrom(PHRASES);
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopCamera();
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    if (!errorScreen.hidden) return;
    heartBtn.hidden = true; startScreen.hidden = false; setStatus("");
    phraseEl.classList.remove("show");
  }
});

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

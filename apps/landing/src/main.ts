import "./style.css";

type Locale = "en" | "ko";
type Copy = Record<string, string>;

const DOWNLOAD_URL = "https://github.com/jbaehova/open-gen-ui/releases/latest/download/OpenGen-UI-macOS-universal.dmg";
const STORAGE_KEY = "opengen-ui-language";

const copy: Record<Locale, Copy> = {
  en: {
    metaTitle: "OpenGen UI — Make every model fit",
    metaDescription: "A clean macOS workspace for image and video generation through OpenRouter.",
    languageLabel: "Language",
    navWork: "The workspace", navMethod: "How it works", navInstall: "Install",
    heroKicker: "IMAGE + VIDEO GENERATION FOR MAC", heroLine1: "MAKE", heroLine2: "EVERY MODEL", heroLine3: "FIT.",
    heroBody: "One sharp workspace that turns OpenRouter's live model catalog into the controls each model actually supports.",
    downloadMac: "DOWNLOAD FOR MAC", downloadMeta: "Universal · Apple Silicon + Intel · Beta",
    workTitle: "STOP GUESSING THE SHAPE OF A REQUEST.",
    workBody: "Pick a model. OpenGen UI reads its capabilities live, keeps unsupported fields out, and shows the exact JSON before anything leaves your Mac.",
    workspaceAlt: "OpenGen UI workspace with model catalog, generation controls, preview, and request inspector",
    featureOneTitle: "THE CATALOG MOVES. THE UI MOVES WITH IT.", featureOneBody: "Image and video models arrive from OpenRouter at runtime.",
    featureTwoTitle: "ONLY THE CONTROLS THAT BELONG.", featureTwoBody: "References, frames, ratios, seed, and provider options appear only when supported.",
    featureThreeTitle: "THE REQUEST, BEFORE THE REQUEST.", featureThreeBody: "Inspect sanitized JSON without leaking large base64 bodies or your key.",
    methodTitle: "THREE CUTS. ONE GENERATION.",
    stepOneTitle: "CHOOSE", stepOneBody: "Select an image or video model from the live catalog.",
    stepTwoTitle: "COMPOSE", stepTwoBody: "Write the prompt and use only the controls that fit.",
    stepThreeTitle: "GENERATE", stepThreeBody: "Inspect the payload, send it, and keep long-running video jobs alive.",
    securityTitle: "YOUR KEY STAYS ON YOUR MACHINE.", securityBody: "Your OpenRouter API key is stored in a permission-restricted local file. Requests pass through the native Rust process, and the key is kept out of previews and logs.",
    readSecurity: "READ THE SECURITY NOTES ↗",
    installTitle: "UNSIGNED. STILL YOURS TO OPEN.", installBody: "OpenGen UI is distributed without Apple notarization. macOS will ask you to approve it once.",
    installOne: "Open the DMG and drag OpenGen UI to Applications.", installTwo: "Try to open the app once.", installThree: "Open System Settings → Privacy & Security → Open Anyway.",
    openAnywayLabel: "AFTER THE FIRST BLOCK", openAnywayTitle: "LOOK FOR THIS BUTTON.",
    openAnywayBody: "Go to System Settings → Privacy & Security. This panel appears in the Security section after macOS blocks the first launch.",
    openAnywayAlt: "macOS Security settings showing the Open Anyway button for OpenGen UI",
    updateLabel: "MANUAL UPDATES FOR NOW", updateTitle: "REPLACE THE APP. KEEP YOUR KEY.", updateBody: "Automatic updates aren't built in yet. Install each new version over the existing app.",
    updateOne: "Quit OpenGen UI.", updateTwo: "Download and open the latest DMG.", updateThree: "Drag OpenGen UI to Applications and choose Replace.", updateFour: "If macOS blocks it again, try to open it once and use Privacy & Security → Open Anyway.",
    updatePersistence: "Your API key stays in ~/.open-gen-ui, outside the app bundle, so replacing the app does not remove it.", downloadLatest: "DOWNLOAD THE LATEST DMG",
    finalTitle: "MAKE SOMETHING MOVE.", footerNote: "Open source. Built for OpenRouter. macOS only.",
  },
  ko: {
    metaTitle: "OpenGen UI — 모든 모델을 아이디어에 맞게",
    metaDescription: "OpenRouter 이미지·비디오 생성을 위한 깔끔한 macOS 워크스페이스.",
    languageLabel: "언어",
    navWork: "워크스페이스", navMethod: "작동 방식", navInstall: "설치",
    heroKicker: "MAC을 위한 이미지 + 비디오 생성", heroLine1: "모든", heroLine2: "모델을", heroLine3: "딱 맞게.",
    heroBody: "OpenRouter의 실시간 모델 카탈로그를 각 모델이 실제로 지원하는 컨트롤로 바꿔주는 하나의 선명한 워크스페이스.",
    downloadMac: "MAC용 다운로드", downloadMeta: "Universal · Apple Silicon + Intel · 베타",
    workTitle: "요청 형식을 더는 추측하지 마세요.",
    workBody: "모델을 고르면 OpenGen UI가 기능을 실시간으로 읽습니다. 지원하지 않는 필드는 빼고, Mac을 떠나기 전 정확한 JSON을 보여줍니다.",
    workspaceAlt: "모델 카탈로그, 생성 컨트롤, 미리보기, 요청 검사기가 있는 OpenGen UI 워크스페이스",
    featureOneTitle: "카탈로그가 바뀌면 UI도 따라 바뀝니다.", featureOneBody: "이미지·비디오 모델을 OpenRouter에서 실시간으로 불러옵니다.",
    featureTwoTitle: "필요한 컨트롤만 남깁니다.", featureTwoBody: "레퍼런스, 프레임, 비율, 시드, 공급자 옵션은 지원될 때만 나타납니다.",
    featureThreeTitle: "요청하기 전에 요청을 확인합니다.", featureThreeBody: "대용량 base64 본문과 API 키를 노출하지 않고 정리된 JSON을 확인합니다.",
    methodTitle: "세 번의 선택. 한 번의 생성.",
    stepOneTitle: "선택", stepOneBody: "실시간 카탈로그에서 이미지 또는 비디오 모델을 고릅니다.",
    stepTwoTitle: "구성", stepTwoBody: "프롬프트를 쓰고 모델에 맞는 컨트롤만 사용합니다.",
    stepThreeTitle: "생성", stepThreeBody: "페이로드를 확인하고 전송합니다. 오래 걸리는 비디오 작업도 이어집니다.",
    securityTitle: "API 키는 내 컴퓨터에 머뭅니다.", securityBody: "OpenRouter API 키는 권한이 제한된 로컬 파일에 저장됩니다. 요청은 네이티브 Rust 프로세스를 거치며 키는 미리보기와 로그에서 제외됩니다.",
    readSecurity: "보안 안내 읽기 ↗",
    installTitle: "미서명. 그래도 직접 열 수 있습니다.", installBody: "OpenGen UI는 Apple 공증 없이 배포됩니다. macOS에서 최초 한 번만 허용하면 됩니다.",
    installOne: "DMG를 열고 OpenGen UI를 Applications로 드래그합니다.", installTwo: "앱을 한 번 실행해 봅니다.", installThree: "시스템 설정 → 개인정보 보호 및 보안 → 그래도 열기를 선택합니다.",
    openAnywayLabel: "처음 차단된 다음", openAnywayTitle: "이 버튼을 찾으세요.",
    openAnywayBody: "시스템 설정 → 개인정보 보호 및 보안으로 이동하세요. macOS가 첫 실행을 차단한 뒤 보안 영역에 이 패널이 나타납니다.",
    openAnywayAlt: "OpenGen UI의 그래도 열기 버튼이 표시된 macOS 보안 설정",
    updateLabel: "현재는 수동 업데이트", updateTitle: "앱만 대치하고 API 키는 그대로.", updateBody: "아직 자동 업데이트 기능은 없습니다. 새 버전을 기존 앱 위에 설치하세요.",
    updateOne: "OpenGen UI를 완전히 종료합니다.", updateTwo: "최신 DMG를 다운로드해 엽니다.", updateThree: "OpenGen UI를 Applications로 드래그하고 ‘대치’를 선택합니다.", updateFour: "macOS가 다시 차단하면 앱을 한 번 연 뒤 개인정보 보호 및 보안 → 그래도 열기를 선택합니다.",
    updatePersistence: "API 키는 앱 밖 ~/.open-gen-ui에 저장되므로 앱을 대치해도 유지됩니다.", downloadLatest: "최신 DMG 다운로드",
    finalTitle: "이제 무언가를 움직여 보세요.", footerNote: "오픈소스. OpenRouter 기반. macOS 전용.",
  },
};

const isLocale = (value: string | null): value is Locale => value !== null && value in copy;

function setLanguage(locale: Locale) {
  const dictionary = copy[locale];
  document.documentElement.lang = locale;
  document.title = dictionary.metaTitle;
  document.querySelector('meta[name="description"]')?.setAttribute("content", dictionary.metaDescription);
  document.querySelector('meta[property="og:title"]')?.setAttribute("content", dictionary.metaTitle);
  document.querySelector('meta[property="og:description"]')?.setAttribute("content", dictionary.metaDescription);

  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((element) => {
    const key = element.dataset.i18n;
    if (key && dictionary[key]) element.textContent = dictionary[key];
  });
  document.querySelectorAll<HTMLImageElement>("[data-i18n-alt]").forEach((element) => {
    const key = element.dataset.i18nAlt;
    if (key && dictionary[key]) element.alt = dictionary[key];
  });
  document.querySelectorAll<HTMLAnchorElement>("[data-download]").forEach((element) => { element.href = DOWNLOAD_URL; });

  const select = document.querySelector<HTMLSelectElement>("#language");
  if (select) {
    select.value = locale;
    select.setAttribute("aria-label", dictionary.languageLabel);
  }
  try { window.localStorage.setItem(STORAGE_KEY, locale); } catch { /* Storage may be unavailable. */ }
}

const select = document.querySelector<HTMLSelectElement>("#language");
let initialLocale: Locale = "en";
try {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (isLocale(stored)) initialLocale = stored;
} catch { /* English remains the default. */ }
setLanguage(initialLocale);
select?.addEventListener("change", () => { if (isLocale(select.value)) setLanguage(select.value); });

document.querySelector<HTMLElement>("#year")!.textContent = String(new Date().getFullYear());

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const revealItems = document.querySelectorAll<HTMLElement>(".reveal");
if (reducedMotion || !("IntersectionObserver" in window)) {
  revealItems.forEach((item) => item.classList.add("is-visible"));
} else {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.13 });
  revealItems.forEach((item) => observer.observe(item));
}

if (!reducedMotion) {
  const hero = document.querySelector<HTMLElement>(".hero");
  hero?.addEventListener("pointermove", (event) => {
    const x = event.clientX / window.innerWidth - 0.5;
    const y = event.clientY / window.innerHeight - 0.5;
    hero.style.setProperty("--pointer-x", x.toFixed(3));
    hero.style.setProperty("--pointer-y", y.toFixed(3));
  });

  let ticking = false;
  window.addEventListener("scroll", () => {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(() => {
      document.documentElement.style.setProperty("--page-scroll", String(Math.min(window.scrollY / window.innerHeight, 2)));
      ticking = false;
    });
  }, { passive: true });
}

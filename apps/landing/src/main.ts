import "./style.css";

type Locale = "en" | "ko" | "ja" | "zh-CN" | "es";
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
    updateLabel: "현재는 수동 업데이트", updateTitle: "앱만 대치하고 API 키는 그대로.", updateBody: "아직 자동 업데이트 기능은 없습니다. 새 버전을 기존 앱 위에 설치하세요.",
    updateOne: "OpenGen UI를 완전히 종료합니다.", updateTwo: "최신 DMG를 다운로드해 엽니다.", updateThree: "OpenGen UI를 Applications로 드래그하고 ‘대치’를 선택합니다.", updateFour: "macOS가 다시 차단하면 앱을 한 번 연 뒤 개인정보 보호 및 보안 → 그래도 열기를 선택합니다.",
    updatePersistence: "API 키는 앱 밖 ~/.open-gen-ui에 저장되므로 앱을 대치해도 유지됩니다.", downloadLatest: "최신 DMG 다운로드",
    finalTitle: "이제 무언가를 움직여 보세요.", footerNote: "오픈소스. OpenRouter 기반. macOS 전용.",
  },
  ja: {
    metaTitle: "OpenGen UI — すべてのモデルをアイデアに合わせる",
    metaDescription: "OpenRouterによる画像・動画生成のためのmacOSワークスペース。",
    languageLabel: "言語",
    navWork: "ワークスペース", navMethod: "仕組み", navInstall: "インストール",
    heroKicker: "MACのための画像＋動画生成", heroLine1: "すべての", heroLine2: "モデルを", heroLine3: "ぴたりと。",
    heroBody: "OpenRouterのライブモデルカタログを、各モデルが本当に対応する操作だけに変える、ひとつの明快なワークスペース。",
    downloadMac: "MAC版をダウンロード", downloadMeta: "Universal · Apple Silicon + Intel · ベータ",
    workTitle: "リクエストの形を、もう推測しない。",
    workBody: "モデルを選ぶと、OpenGen UIが機能をリアルタイムに読み取ります。未対応の項目を除き、Macから送信される前に正確なJSONを表示します。",
    workspaceAlt: "モデルカタログ、生成コントロール、プレビュー、リクエストインスペクターを備えたOpenGen UI",
    featureOneTitle: "カタログが動けば、UIも動く。", featureOneBody: "画像・動画モデルをOpenRouterから実行時に取得します。",
    featureTwoTitle: "必要な操作だけを表示。", featureTwoBody: "参照画像、フレーム、比率、シード、プロバイダー設定は対応時だけ現れます。",
    featureThreeTitle: "送る前に、リクエストを見る。", featureThreeBody: "巨大なbase64本文やキーを見せずに、整理されたJSONを確認できます。",
    methodTitle: "3つのカット。1つの生成。",
    stepOneTitle: "選ぶ", stepOneBody: "ライブカタログから画像または動画モデルを選択します。",
    stepTwoTitle: "組み立てる", stepTwoBody: "プロンプトを書き、モデルに合う操作だけを使います。",
    stepThreeTitle: "生成する", stepThreeBody: "ペイロードを確認して送信。時間のかかる動画ジョブも継続します。",
    securityTitle: "APIキーは、このMacに。", securityBody: "OpenRouter APIキーは権限を制限したローカルファイルに保存されます。リクエストはネイティブRustプロセスを通り、キーはプレビューとログに出ません。",
    readSecurity: "セキュリティ情報を読む ↗",
    installTitle: "未署名。それでも開けます。", installBody: "OpenGen UIはAppleの公証なしで配布されます。macOSで最初の一度だけ許可してください。",
    installOne: "DMGを開き、OpenGen UIをApplicationsへドラッグします。", installTwo: "アプリを一度開いてみます。", installThree: "システム設定 → プライバシーとセキュリティ → このまま開く を選びます。",
    updateLabel: "現在は手動アップデート", updateTitle: "アプリだけを置き換え、APIキーはそのまま。", updateBody: "自動アップデートはまだありません。新しいバージョンを既存のアプリに上書きします。",
    updateOne: "OpenGen UIを完全に終了します。", updateTwo: "最新のDMGをダウンロードして開きます。", updateThree: "OpenGen UIをApplicationsへドラッグし、「置き換える」を選びます。", updateFour: "macOSに再びブロックされた場合は、一度開いてから「プライバシーとセキュリティ」→「このまま開く」を選びます。",
    updatePersistence: "APIキーはアプリ外の~/.open-gen-uiに保存されるため、アプリを置き換えても残ります。", downloadLatest: "最新のDMGをダウンロード",
    finalTitle: "さあ、何かを動かそう。", footerNote: "オープンソース。OpenRouter対応。macOS専用。",
  },
  "zh-CN": {
    metaTitle: "OpenGen UI — 让每个模型贴合创意",
    metaDescription: "面向OpenRouter图像与视频生成的简洁macOS工作区。",
    languageLabel: "语言",
    navWork: "工作区", navMethod: "工作方式", navInstall: "安装",
    heroKicker: "为MAC而生的图像＋视频生成", heroLine1: "让每个", heroLine2: "模型都", heroLine3: "恰到好处。",
    heroBody: "一个清晰的工作区，把OpenRouter实时模型目录转换成每个模型真正支持的控件。",
    downloadMac: "下载MAC版", downloadMeta: "Universal · Apple Silicon + Intel · 测试版",
    workTitle: "不再猜测请求应该长什么样。",
    workBody: "选择模型后，OpenGen UI会实时读取其能力，排除不支持的字段，并在数据离开Mac前显示准确的JSON。",
    workspaceAlt: "包含模型目录、生成控件、预览和请求检查器的OpenGen UI工作区",
    featureOneTitle: "目录变化，界面随之变化。", featureOneBody: "运行时直接从OpenRouter载入图像与视频模型。",
    featureTwoTitle: "只留下真正支持的控件。", featureTwoBody: "参考图、帧、比例、种子与提供商选项仅在支持时出现。",
    featureThreeTitle: "发送之前，先看清请求。", featureThreeBody: "检查经过整理的JSON，不暴露大型base64内容或API密钥。",
    methodTitle: "三步剪辑。一次生成。",
    stepOneTitle: "选择", stepOneBody: "从实时目录选择图像或视频模型。",
    stepTwoTitle: "编排", stepTwoBody: "输入提示词，只使用适合该模型的控件。",
    stepThreeTitle: "生成", stepThreeBody: "检查并发送负载，耗时的视频任务也会持续跟踪。",
    securityTitle: "API密钥留在你的电脑上。", securityBody: "OpenRouter API密钥保存在权限受限的本地文件中。请求经过原生Rust进程，密钥不会出现在预览或日志里。",
    readSecurity: "阅读安全说明 ↗",
    installTitle: "未经签名，仍可由你决定打开。", installBody: "OpenGen UI未经过Apple公证。只需在macOS中手动允许一次。",
    installOne: "打开DMG，将OpenGen UI拖入Applications。", installTwo: "尝试打开一次应用。", installThree: "打开系统设置 → 隐私与安全性 → 仍要打开。",
    updateLabel: "目前采用手动更新", updateTitle: "替换应用，保留API密钥。", updateBody: "目前尚未内置自动更新。将新版本覆盖安装到现有应用即可。",
    updateOne: "完全退出OpenGen UI。", updateTwo: "下载并打开最新DMG。", updateThree: "将OpenGen UI拖入Applications，并选择“替换”。", updateFour: "如果macOS再次阻止，请先尝试打开一次，再前往“隐私与安全性”→“仍要打开”。",
    updatePersistence: "API密钥保存在应用之外的~/.open-gen-ui中，替换应用不会删除它。", downloadLatest: "下载最新DMG",
    finalTitle: "现在，让创意动起来。", footerNote: "开源。基于OpenRouter。仅支持macOS。",
  },
  es: {
    metaTitle: "OpenGen UI — Haz que cada modelo encaje",
    metaDescription: "Un espacio de trabajo macOS para generar imágenes y vídeo con OpenRouter.",
    languageLabel: "Idioma",
    navWork: "El espacio", navMethod: "Cómo funciona", navInstall: "Instalar",
    heroKicker: "IMAGEN + VÍDEO PARA MAC", heroLine1: "HAZ QUE", heroLine2: "CADA MODELO", heroLine3: "ENCAJE.",
    heroBody: "Un único espacio que convierte el catálogo en vivo de OpenRouter en los controles que cada modelo admite de verdad.",
    downloadMac: "DESCARGAR PARA MAC", downloadMeta: "Universal · Apple Silicon + Intel · Beta",
    workTitle: "DEJA DE ADIVINAR LA FORMA DE CADA SOLICITUD.",
    workBody: "Elige un modelo. OpenGen UI lee sus capacidades en vivo, descarta campos incompatibles y muestra el JSON exacto antes de que salga de tu Mac.",
    workspaceAlt: "Espacio OpenGen UI con catálogo de modelos, controles, vista previa e inspector de solicitudes",
    featureOneTitle: "EL CATÁLOGO CAMBIA. LA INTERFAZ TAMBIÉN.", featureOneBody: "Los modelos de imagen y vídeo llegan de OpenRouter en tiempo real.",
    featureTwoTitle: "SOLO LOS CONTROLES QUE CORRESPONDEN.", featureTwoBody: "Referencias, fotogramas, proporciones, semilla y opciones aparecen solo si se admiten.",
    featureThreeTitle: "LA SOLICITUD, ANTES DE ENVIARLA.", featureThreeBody: "Inspecciona el JSON limpio sin exponer cuerpos base64 enormes ni tu clave.",
    methodTitle: "TRES CORTES. UNA GENERACIÓN.",
    stepOneTitle: "ELIGE", stepOneBody: "Selecciona un modelo de imagen o vídeo del catálogo en vivo.",
    stepTwoTitle: "COMPÓN", stepTwoBody: "Escribe el prompt y usa solo los controles adecuados.",
    stepThreeTitle: "GENERA", stepThreeBody: "Revisa la carga, envíala y conserva los trabajos de vídeo de larga duración.",
    securityTitle: "TU CLAVE SE QUEDA EN TU MÁQUINA.", securityBody: "La clave de OpenRouter se guarda en un archivo local con permisos restringidos. Las solicitudes pasan por el proceso nativo en Rust y la clave no aparece en vistas previas ni registros.",
    readSecurity: "LEER LAS NOTAS DE SEGURIDAD ↗",
    installTitle: "SIN FIRMA. AUN ASÍ, TÚ DECIDES ABRIRLA.", installBody: "OpenGen UI se distribuye sin notarización de Apple. macOS te pedirá aprobarla una sola vez.",
    installOne: "Abre el DMG y arrastra OpenGen UI a Applications.", installTwo: "Intenta abrir la aplicación una vez.", installThree: "Abre Ajustes del Sistema → Privacidad y seguridad → Abrir igualmente.",
    updateLabel: "ACTUALIZACIONES MANUALES POR AHORA", updateTitle: "SUSTITUYE LA APP. CONSERVA TU CLAVE.", updateBody: "Las actualizaciones automáticas aún no están integradas. Instala cada versión nueva sobre la aplicación existente.",
    updateOne: "Cierra OpenGen UI por completo.", updateTwo: "Descarga y abre el DMG más reciente.", updateThree: "Arrastra OpenGen UI a Applications y elige Reemplazar.", updateFour: "Si macOS vuelve a bloquearla, intenta abrirla y usa Privacidad y seguridad → Abrir igualmente.",
    updatePersistence: "La clave se guarda fuera de la app, en ~/.open-gen-ui, por lo que se conserva al reemplazarla.", downloadLatest: "DESCARGAR EL DMG MÁS RECIENTE",
    finalTitle: "HAZ QUE ALGO SE MUEVA.", footerNote: "Código abierto. Para OpenRouter. Solo macOS.",
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

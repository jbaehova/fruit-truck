# Fruit Truck

Fruit Truck es un espacio de trabajo para macOS que genera imágenes y vídeos mediante OpenRouter.

- Campos de solicitud adaptados a cada modelo y edición de imágenes
- Valor predeterminado de mejora de prompts aplicado de inmediato a todos los hilos
- Hilos paralelos, seguimiento de vídeos y costes por sesión
- Una única biblioteca para archivos subidos y resultados generados

Ejecuta `npm ci`, `npm run check`, `npm run test:unit` y `npm run test:e2e` desde `apps/desktop`. Playwright se ejecuta sin interfaz a 1920×1080.

La distribución de macOS incluye únicamente `ffprobe`, compilado desde el proyecto FFmpeg. No incluye el ejecutable `ffmpeg`. Se conservan los avisos LGPL porque FFprobe forma parte del proyecto FFmpeg.

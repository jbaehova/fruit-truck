# Fruit Truck

Fruit Truck es un espacio de trabajo para macOS que genera imágenes y vídeos mediante OpenRouter.

- Campos de solicitud adaptados a cada modelo y edición de imágenes
- Valor predeterminado de mejora de prompts aplicado de inmediato a todos los hilos
- Hilos paralelos, seguimiento de vídeos y costes por sesión
- Una única biblioteca para archivos subidos y resultados generados

## Alcance compatible

| Capacidad | Endpoint | Estado |
| --- | --- | --- |
| Texto a imagen y edición de imágenes | `/api/v1/images` | Compatible según las capacidades verificadas del endpoint elegido |
| Texto a vídeo | `/api/v1/videos` | Compatible con seguimiento persistente del trabajo |
| Mejora del prompt | `/api/v1/chat/completions` | Solicitud opcional al planificador; no es un chat general |
| Referencias y edición de imagen/vídeo/audio para vídeo | `/api/v1/videos` | No disponible hasta verificar un transporte HTTPS público o signed-upload |
| Chat general, Responses, tool/function calling, TTS, STT, audio output, embeddings | Varios | No se ofrece en este estudio |

Que un modelo aparezca en el catálogo no significa que todos los endpoints de
OpenRouter estén disponibles. La ruta real la determinan los metadatos del
endpoint y el validador de solicitudes de Fruit Truck. Consulta la
[matriz de soporte](../SUPPORT.md) para más detalles.

Ejecuta `npm ci`, `npm run check`, `npm run test:unit` y `npm run test:e2e` desde `apps/desktop`. Playwright se ejecuta sin interfaz a 1920×1080.

La distribución de macOS incluye únicamente `ffprobe`, compilado desde el proyecto FFmpeg. No incluye el ejecutable `ffmpeg`. Se conservan los avisos LGPL porque FFprobe forma parte del proyecto FFmpeg.

La clave se guarda en este Mac, pero al generar el prompt y los medios elegidos
se envían a OpenRouter y pueden reenviarse al proveedor downstream seleccionado.
Si la mejora del prompt está activada, se envía antes una solicitud independiente
al planificador que puede tener coste. Se aplican las políticas de retención, entrenamiento y
ZDR del proveedor; guardar la clave localmente no convierte la generación en
local.

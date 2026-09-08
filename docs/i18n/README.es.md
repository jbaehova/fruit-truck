# Fruit Truck

https://github.com/user-attachments/assets/e1cce464-0311-46fa-ae96-fe360019dee2

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
| Imágenes del fotograma inicial/final para vídeo | `/api/v1/videos` | Compatible cuando el modelo elegido declara cada función; las imágenes locales gestionadas usan el contrato media URL de OpenRouter |
| Referencias generales de imagen/vídeo/audio para vídeo | `/api/v1/videos` | Solo para los tipos, límites y transportes permitidos por el endpoint o la regla exacta del modelo |
| Chat general, Responses, tool/function calling, TTS, STT, audio output, embeddings | Varios | No se ofrece en este estudio |

Que un modelo aparezca en el catálogo no significa que todos los endpoints de
OpenRouter estén disponibles. Las reglas del catálogo en vivo y del endpoint
tienen prioridad. El catálogo público de vídeo no publica todos los tipos y
límites de referencias generales por modelo, así que Fruit Truck completa solo
los campos ausentes con reglas documentadas para el modelo exacto y no activa
combinaciones desconocidas.

Los fotogramas y las referencias generales no se pueden mezclar porque
OpenRouter da prioridad a `frame_images`. Veo 3.1 Standard y Fast aceptan hasta
tres referencias generales de imagen, todas con el tipo semántico nativo fijo
`asset`; Lite no acepta referencias generales. Una finalidad como estilo o
personaje solo afecta al prompt y no se convierte en un `reference_type` nativo.
Consulta la [matriz de soporte](../SUPPORT.md) para más detalles.

Ejecuta `npm ci`, `npm run check`, `npm run test:unit` y `npm run test:e2e` desde `apps/desktop`. Playwright se ejecuta sin interfaz a 1920×1080.

La distribución de macOS incluye únicamente `ffprobe`, compilado desde el proyecto FFmpeg. No incluye el ejecutable `ffmpeg`. Se conservan los avisos LGPL porque FFprobe forma parte del proyecto FFmpeg.

La clave se guarda en este Mac, pero al generar el prompt y los medios elegidos
se envían a OpenRouter y pueden reenviarse al proveedor downstream seleccionado.
Si la mejora del prompt está activada, se envía antes una solicitud independiente
al planificador que puede tener coste. Se aplican las políticas de retención, entrenamiento y
ZDR del proveedor; guardar la clave localmente no convierte la generación en
local.

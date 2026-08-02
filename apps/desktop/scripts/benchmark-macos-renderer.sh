#!/usr/bin/env bash

set -Eeuo pipefail

INPUT="${1:?Path to a representative MP4, MOV, or WebM clip is required.}"
OUTPUT_DIR="${2:?Output directory is required.}"
FFMPEG_BIN="${FFMPEG_BIN:-ffmpeg}"
FFPROBE_BIN="${FFPROBE_BIN:-ffprobe}"
BENCHMARK_SECONDS="${BENCHMARK_SECONDS:-10}"

[[ "$(uname -s)" == "Darwin" ]] || {
  printf 'This benchmark compares Apple VideoToolbox and libx264 on macOS.\n' >&2
  exit 1
}
[[ -f "${INPUT}" ]] || {
  printf 'Input does not exist: %s\n' "${INPUT}" >&2
  exit 1
}
command -v "${FFMPEG_BIN}" >/dev/null 2>&1
command -v "${FFPROBE_BIN}" >/dev/null 2>&1

ENCODERS="$("${FFMPEG_BIN}" -hide_banner -encoders)"
grep -q 'h264_videotoolbox' <<<"${ENCODERS}" || {
  printf 'The selected FFmpeg does not include h264_videotoolbox.\n' >&2
  exit 1
}
grep -q 'libx264' <<<"${ENCODERS}" || {
  printf 'The reference benchmark requires a developer FFmpeg with libx264.\n' >&2
  exit 1
}

dimensions="$("${FFPROBE_BIN}" \
  -v error \
  -select_streams v:0 \
  -show_entries stream=width,height \
  -of csv=s=x:p=0 \
  "${INPUT}")"
IFS=x read -r width height <<<"${dimensions}"
width=$((width - width % 2))
height=$((height - height % 2))
(( width >= 2 && height >= 2 && width <= 8192 && height <= 8192 )) || {
  printf 'Unsupported input dimensions: %s\n' "${dimensions}" >&2
  exit 1
}

bitrate=$((width * height * 30 * 16 / 100))
(( bitrate < 4000000 )) && bitrate=4000000
(( bitrate > 40000000 )) && bitrate=40000000
normalize="trim=duration=${BENCHMARK_SECONDS},setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30"

mkdir -p -- "${OUTPUT_DIR}"

render_case() {
  local label="$1"
  shift
  /usr/bin/time -l \
    "${FFMPEG_BIN}" \
    -hide_banner -loglevel error -nostdin -y \
    -i "${INPUT}" \
    -vf "${normalize}" \
    -an \
    "$@" \
    -pix_fmt yuv420p \
    -movflags +faststart \
    "${OUTPUT_DIR}/${label}.mp4" \
    >/dev/null 2>"${OUTPUT_DIR}/${label}.time.txt"
}

render_case videotoolbox \
  -c:v h264_videotoolbox \
  -profile:v high \
  -allow_sw 0 \
  -prio_speed 0 \
  -b:v "${bitrate}"
render_case libx264 \
  -c:v libx264 \
  -preset medium \
  -crf 18

measure_quality() {
  local label="$1"
  local quality_log="${OUTPUT_DIR}/${label}.quality.txt"
  local filter="[0:v]${normalize},format=yuv420p[reference];\
[1:v]setpts=PTS-STARTPTS,format=yuv420p[test];\
[reference]split=2[ref_psnr][ref_ssim];\
[test]split=2[test_psnr][test_ssim];\
[ref_psnr][test_psnr]psnr;[ref_ssim][test_ssim]ssim"
  "${FFMPEG_BIN}" \
    -hide_banner -nostdin \
    -i "${INPUT}" \
    -i "${OUTPUT_DIR}/${label}.mp4" \
    -filter_complex "${filter}" \
    -an -f null - \
    >/dev/null 2>"${quality_log}"
}

measure_quality videotoolbox
measure_quality libx264

metric_line() {
  grep -m 1 ' real ' "$1" | sed -E 's/^[[:space:]]+//'
}
quality_value() {
  local pattern="$1"
  local file="$2"
  grep "${pattern}" "${file}" | tail -n 1 | sed -E 's/^.*(PSNR|SSIM) //' | tr '|' ' '
}

report="${OUTPUT_DIR}/report.md"
{
  printf '# Fruit Truck macOS renderer benchmark\n\n'
  printf -- '- Input: `%s`\n' "${INPUT}"
  printf -- '- Normalized output: %sx%s, 30 fps, %.0f seconds\n' "${width}" "${height}" "${BENCHMARK_SECONDS}"
  printf -- '- VideoToolbox target bitrate: %s bit/s\n\n' "${bitrate}"
  printf '| Encoder | Time (real/user/sys) | Bytes | Quality summary |\n'
  printf '| --- | ---: | ---: | --- |\n'
  for label in videotoolbox libx264; do
    size="$(stat -f '%z' "${OUTPUT_DIR}/${label}.mp4")"
    time_value="$(metric_line "${OUTPUT_DIR}/${label}.time.txt")"
    psnr="$(quality_value 'PSNR' "${OUTPUT_DIR}/${label}.quality.txt")"
    ssim="$(quality_value 'SSIM' "${OUTPUT_DIR}/${label}.quality.txt")"
    printf '| %s | %s | %s | PSNR %s; SSIM %s |\n' \
      "${label}" "${time_value}" "${size}" "${psnr}" "${ssim}"
  done
  printf '\nThis report is diagnostic and does not impose an absolute release gate.\n'
} > "${report}"

printf 'Benchmark report: %s\n' "${report}"

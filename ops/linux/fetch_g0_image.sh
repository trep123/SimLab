#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "请使用 root 运行镜像拉取脚本" >&2
  exit 1
fi

readonly RELEASE="release-20260725"
readonly IMAGE_NAME="ubuntu-24.04-server-cloudimg-amd64.img"
readonly EXPECTED_SHA256="d1940f7d69d343355e183dff1e08a59852d32e7309baa7a4bad8365b11b005ac"
readonly SOURCE_ROOT="https://cloud-images.ubuntu.com/releases/noble/${RELEASE}"
readonly IMAGE_ROOT="/var/lib/simlab/image-store/ubuntu-noble-20260725"
readonly BASE_IMAGE="${IMAGE_ROOT}/base.qcow2"

install -d -m 0755 "${IMAGE_ROOT}"

if [[ -f "${BASE_IMAGE}" ]] && printf '%s  %s\n' "${EXPECTED_SHA256}" "${BASE_IMAGE}" | sha256sum --check --strict; then
  echo "复用已通过固定 SHA-256 校验的基础镜像：${BASE_IMAGE}"
else
  curl --fail --location --retry 4 --retry-all-errors \
    --output "${IMAGE_ROOT}/SHA256SUMS" "${SOURCE_ROOT}/SHA256SUMS"
  grep -F "${EXPECTED_SHA256} *${IMAGE_NAME}" "${IMAGE_ROOT}/SHA256SUMS" >/dev/null
  curl --fail --location --retry 5 --continue-at - \
    --output "${BASE_IMAGE}.partial" "${SOURCE_ROOT}/${IMAGE_NAME}"
  printf '%s  %s\n' "${EXPECTED_SHA256}" "${BASE_IMAGE}.partial" | sha256sum --check --strict
  mv "${BASE_IMAGE}.partial" "${BASE_IMAGE}"
fi

qemu-img info --output=json "${BASE_IMAGE}"
qemu-img check --output=json "${BASE_IMAGE}"
chmod 0444 "${BASE_IMAGE}"
if [[ -f "${IMAGE_ROOT}/SHA256SUMS" ]]; then
  chmod 0444 "${IMAGE_ROOT}/SHA256SUMS"
fi
echo "已登记只读基础镜像：${BASE_IMAGE}"

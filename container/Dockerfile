# Test/CI image: herdr + pi + a headless Chromium, so the plugin is always
# exercised against a real herdr server inside a container.
#
# Build:  docker build -f container/Dockerfile -t herdr-mobile-test .
FROM node:24-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    PATH=/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    LANG=C.UTF-8

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq procps tini \
      chromium \
      fonts-noto-cjk \
      locales \
    && rm -rf /var/lib/apt/lists/* \
    && sed -i 's/# C.UTF-8/C.UTF-8/' /etc/locale.gen || true

# herdr: the multiplexer the plugin talks to.
RUN curl -fsSL https://herdr.dev/install.sh | sh

# pi: the coding agent used for the end-to-end test pane.
RUN curl -fsSL https://pi.dev/install.sh | sh \
    || npm install -g --ignore-scripts @earendil-works/pi-coding-agent

# Browser driver for the UI test. No bundled browser: it drives the system Chromium.
RUN npm install -g --ignore-scripts puppeteer-core@23

WORKDIR /work
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bash"]

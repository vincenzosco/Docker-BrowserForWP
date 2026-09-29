# The render server, as a container.
#
# The base image is Playwright's own, because it already carries Chromium and the
# shared libraries a headless Chromium needs. Building Chromium's dependencies by
# hand on a slim base is a week of work that this image makes free, and the
# version of the browsers must match the version of the `playwright` package
# anyway -- which the tag below is what pins.
#
# Override the tag with:
#   docker build --build-arg PLAYWRIGHT_TAG=v1.49.1-jammy .
# and keep it in step with the `playwright` range in package.json. docs/DEPLOY.md
# says how to check.
ARG PLAYWRIGHT_TAG=v1.49.1-jammy
FROM mcr.microsoft.com/playwright:${PLAYWRIGHT_TAG}

# The base image already has the browsers under /ms-playwright. Installing the
# npm package must not download them a second time.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_ENV=production

# Audio needs a virtual sound device and an encoder, and neither is needed by a
# server that is only drawing pages. It is a build argument rather than a default
# because it roughly doubles the image and cannot be verified by the test suite.
ARG WITH_AUDIO=0

USER root
RUN if [ "$WITH_AUDIO" = "1" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends ffmpeg pulseaudio \
      && rm -rf /var/lib/apt/lists/*; \
    fi \
 && mkdir -p /etc/bfwp/tls /var/lib/bfwp /run/bfwp \
 && chown -R pwuser:pwuser /var/lib/bfwp /run/bfwp

WORKDIR /app

# Dependencies first: a change to src/ must not reinstall them.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY protocol ./protocol
COPY src ./src
COPY bin ./bin

USER pwuser

# 8443 is the render channel (TLS 1.3 only). 8444 is the audio endpoint, spoken
# to by MediaElement over TLS 1.2+ and only opened when audio is enabled.
EXPOSE 8443 8444

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "bin/healthcheck.js"]

CMD ["node", "bin/bfwp-render.js"]

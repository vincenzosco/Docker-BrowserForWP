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

# Re-declared INSIDE the stage: before FROM it is a global build argument, and
# after FROM a name that is not re-declared is empty. The check below needs it.
ARG PLAYWRIGHT_TAG

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
#
# AND THEN CHECK THE PAIR, because the failure it catches is invisible at build
# time and specific in production: the tag ships the browsers, the npm package
# drives them, and a package newer than the image leaves a server that starts,
# accepts a device, seals frames -- and then cannot launch a browser at all.
# "Executable doesn't exist at /ms-playwright/chromium_headless_shell-1243" is
# what an operator would see, on their first page, with a healthy container.
# The first build of this image had exactly that, because package.json declared
# an open range (`>=1.40 <2`) and npm resolved it to a version years ahead of the
# tag. The version is pinned now, and this refuses to produce the image if the
# two ever drift apart again.
COPY package.json ./
RUN set -eux; \
    npm install --omit=dev --no-audit --no-fund; \
    npm cache clean --force; \
    installed="$(node -p "require('playwright/package.json').version")"; \
    expected="${PLAYWRIGHT_TAG#v}"; \
    expected="${expected%%-*}"; \
    if [ "$installed" != "$expected" ]; then \
      echo "playwright $installed does not match the base image $PLAYWRIGHT_TAG" >&2; \
      echo "The tag ships the browsers; the package drives them. Pin one to the other." >&2; \
      exit 1; \
    fi; \
    echo "playwright $installed matches $PLAYWRIGHT_TAG"

COPY protocol ./protocol
COPY src ./src
COPY bin ./bin

# Both are executed, and a COPY preserves the source file's mode: if one arrives
# without the execute bit the container fails with "permission denied" at the least
# helpful moment -- for the entrypoint that is every start. One line here, and the
# mode in git, both say the same thing.
RUN chmod +x /app/bin/entrypoint.sh /app/bin/bfwp-device.sh

# ROOT AT START ONLY, to stage the certificate: the mounted private key belongs to
# the host's user and a bind mount cannot be chowned from inside, while the server
# must not run as root. bin/entrypoint.sh copies the pair somewhere the app user
# can read it and then drops to pwuser for the actual process -- see that file for
# why a documented `chown` was not good enough. The image itself contains nothing
# writable by the app user, so the window is a copy and an exec.
USER root

# 8443 is the render channel (TLS 1.3 only). 8444 is the audio endpoint, spoken
# to by MediaElement over TLS 1.2+, and only opened when audio is enabled. 8445 is
# the registration page (TLS 1.2+), and 8080 is its plain-http twin, which answers
# 301 and nothing else. Neither listens anywhere unless a deployment says so -- see
# src/config.js -- and both are unprivileged ports on purpose: this image runs as
# uid 1000 and asks for no capabilities, so the host's 80 and 443 are mapped onto
# these from docker-compose.yml.
EXPOSE 8443 8444 8445 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "bin/healthcheck.js"]

# The entrypoint receives this as its arguments and passes them on after it has
# dropped privileges. It is exec form for exactly that reason.
ENTRYPOINT ["/app/bin/entrypoint.sh"]
CMD ["node", "bin/bfwp-render.js"]

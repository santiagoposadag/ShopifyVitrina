# syntax=docker/dockerfile:1
#
# Build context is the bridge/ directory (unlike the Node images, which need the
# repo root for npm workspaces):
#   docker build -f bridge/Dockerfile -t vitrina-bridge bridge/
# compose.yaml already sets context: ./bridge for this file.

FROM golang:1.26-bookworm AS build
WORKDIR /src

# Dependencies first so the module cache survives source-only edits.
COPY go.mod go.sum ./
RUN go mod download

COPY *.go ./
# CGO_ENABLED=0 is what lets the runtime stage be distroless-static: the SQLite
# driver is modernc's pure-Go one precisely so no libc is needed here.
# Stripping the symbol table keeps the binary small; nothing debugs in prod.
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/bridge .

# Volume mountpoints, staged here because the runtime image has no shell to
# mkdir with. A named volume inherits the ownership of the image directory it
# covers; a mountpoint Docker has to invent is created root-owned, and a non-root
# process cannot write to it.
RUN mkdir -p /out/session /out/inbound

# ---------------------------------------------------------------------------
# runtime: distroless. No shell, no package manager, nothing to exec into —
# this container holds a live WhatsApp session for the business's number.
# ---------------------------------------------------------------------------
FROM gcr.io/distroless/static-debian12:nonroot

# uid 1000 — the `node` user in the server image — NOT distroless's own `nonroot`
# (65532). The two containers share the staging volume: the bridge creates files
# there and the server deletes them once read, and unlinking needs write
# permission on the DIRECTORY, not the file. Under mismatched uids the server
# would read every photo fine and silently fail to clean any of them up, leaking
# a file per customer photo forever.
COPY --from=build --chown=1000:1000 /out/bridge /bridge
COPY --from=build --chown=1000:1000 /out/session /session
COPY --from=build --chown=1000:1000 /out/inbound /data/inbound
USER 1000:1000

EXPOSE 3002

CMD ["/bridge"]

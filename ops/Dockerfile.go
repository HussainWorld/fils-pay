# FIX D-1: docker-compose.yml built this file but it was never committed.
# Multi-stage build of apps/settlement. The Go toolchain and module/build
# caches stay in the builder stage; the runtime image is the static binary
# on alpine. After building on the hosted box, run `docker builder prune -f`
# (ops/deploy.sh does) — the build cache is what filled the 2 GB disk before.
FROM golang:1.24-alpine AS build

WORKDIR /src
COPY apps/settlement/go.mod apps/settlement/go.sum ./
RUN go mod download
COPY apps/settlement/ ./
# CGO off for a static binary. The Asia/Bahrain zone is embedded via the
# time/tzdata import in cmd/settlement, so the runtime image needs no tzdata.
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/settlement ./cmd/settlement

FROM alpine:3.20
RUN adduser -D -H settlement
WORKDIR /app
COPY --from=build /out/settlement ./settlement
USER settlement

# Internal API (SETTLEMENT_INTERNAL_PORT); reachable only on the compose network.
EXPOSE 8091
CMD ["./settlement", "daemon"]

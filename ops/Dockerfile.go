# Added: this file was referenced by docker-compose.yml but never committed.
# Multi-stage build of apps/settlement. Build context is the repo root.
FROM golang:1.22-alpine AS build

WORKDIR /src
COPY apps/settlement/go.mod apps/settlement/go.sum ./
RUN go mod download

COPY apps/settlement/ ./
RUN CGO_ENABLED=0 go build -o /out/settlement ./cmd/settlement

FROM alpine:3.20

WORKDIR /app
COPY --from=build /out/settlement ./settlement

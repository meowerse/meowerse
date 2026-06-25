# Build context MUST be the repo root so go.work + packages/go-shared resolve.
#   docker build -f apps/api/Dockerfile -t meowerse-api .
FROM golang:1.26-alpine AS build
WORKDIR /src

# Prime the module cache using just the manifests for better layer caching.
COPY go.work ./
COPY apps/api/go.mod apps/api/go.sum ./apps/api/
COPY packages/go-shared/go.mod ./packages/go-shared/
RUN cd apps/api && go mod download

# Bring in the full source and build a static, CGO-free binary.
COPY . .
RUN cd apps/api && CGO_ENABLED=0 go build -o /out/api .

FROM gcr.io/distroless/static-debian12
COPY --from=build /out/api /api
ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["/api"]

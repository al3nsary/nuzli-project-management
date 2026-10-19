# Nuzli converter — MS Project .mpp → MSPDI XML (owner request A9, ADR-111).
# A tiny Java HTTP server (src/ConverterServer.java) around MPXJ, compiled at image build.
# MPXJ is downloaded from its GitHub release and verified against a pinned SHA-256.
#   docker compose builds it from docker-compose.yml (service `converter`).
# To upgrade: change MPXJ_VERSION and MPXJ_SHA256 together (the release page lists the digest).

ARG MPXJ_VERSION=16.9.0
ARG MPXJ_SHA256=e97b8eed9256d0d07d3edd7da92a9070238d1416f015a45ac05ae544531595ba

# ───────────────────────────── build: fetch + verify MPXJ, compile the server
FROM eclipse-temurin:21-jdk AS build
ARG MPXJ_VERSION
ARG MPXJ_SHA256
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates unzip \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN curl -fsSL --retry 3 -o mpxj.zip "https://github.com/joniles/mpxj/releases/download/v${MPXJ_VERSION}/mpxj-${MPXJ_VERSION}.zip" \
 && echo "${MPXJ_SHA256}  mpxj.zip" | sha256sum -c - \
 && unzip -q mpxj.zip 'mpxj/mpxj.jar' 'mpxj/lib/*' \
 && rm mpxj.zip \
 # Test-only libraries are not needed at run time.
 && rm -f mpxj/lib/junit-* mpxj/lib/opentest4j-* mpxj/lib/apiguardian-* mpxj/lib/jgoodies-*
COPY src/ConverterServer.java src/
RUN mkdir classes \
 && javac --release 21 -cp "mpxj/mpxj.jar:mpxj/lib/*" -d classes src/ConverterServer.java

# ───────────────────────────── runtime: JRE only, non-root, read-only friendly
FROM eclipse-temurin:21-jre
RUN groupadd --system --gid 10001 converter && useradd --system --uid 10001 --gid converter --no-create-home converter
WORKDIR /app
COPY --from=build /build/mpxj/mpxj.jar /app/lib/mpxj.jar
COPY --from=build /build/mpxj/lib/ /app/lib/
COPY --from=build /build/classes/ /app/classes/
USER converter
ENV PORT=8080 \
    JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=75 -Djava.io.tmpdir=/tmp -Djava.awt.headless=true"
EXPOSE 8080
ENTRYPOINT ["java", "-cp", "/app/classes:/app/lib/*", "ConverterServer"]

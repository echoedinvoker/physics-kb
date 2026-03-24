FROM oven/bun:1.3

WORKDIR /app

# Install agent dependencies
COPY agent/package.json agent/bun.lock agent/
RUN cd agent && bun install --frozen-lockfile

# Copy all source
COPY . .

# Symlink bun to where server.ts expects it
RUN mkdir -p /root/.bun/bin && ln -s /usr/local/bin/bun /root/.bun/bin/bun

EXPOSE 8080

ENV PORT=8080
CMD ["bun", "run", "demo/server.ts"]

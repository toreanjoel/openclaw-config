# Use Debian-based Node image
FROM node:22-slim

# Install system build dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    cmake \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install OpenClaw globally
RUN npm install -g openclaw --no-cache

# Set the working directory
WORKDIR /app

# Create directory and set permissions
RUN mkdir -p /home/node/.openclaw/workspace && \
    chown -R node:node /home/node/.openclaw /app

# Switch to the node user for safety
USER node

# Default command (will be overridden by docker-compose)
CMD ["openclaw", "gateway", "run", "--bind", "0.0.0.0"]
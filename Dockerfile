FROM node:18-alpine

WORKDIR /app

# Copy package.json only
COPY package.json ./

# Use npm install (NOT npm ci) — no lock file needed
RUN npm install --production

# Copy all source files
COPY . .

# Start the server
CMD ["node", "index.js"]

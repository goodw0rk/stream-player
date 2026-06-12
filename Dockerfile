FROM mcr.microsoft.com/playwright:v1.52.0-jammy

WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .

# Install specific Playwright browsers
RUN npx playwright install chromium --with-deps

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]

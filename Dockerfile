# Use official Playwright image with all browsers
FROM mcr.microsoft.com/playwright:v1.52.0-jammy

# Set working directory
WORKDIR /app

# Copy package files first (for better caching)
COPY package*.json ./

# Install dependencies
RUN npm install --production=false

# Copy the rest of the application
COPY . .

# Create screenshots directory
RUN mkdir -p /app/screenshots

# Expose port
EXPOSE 4000

# Start the application
CMD ["npm", "start"]

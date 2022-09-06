FROM denoland/deno:1.25.1

WORKDIR /app

# Prefer not to run as root.
# USER deno

# These steps will be re-run upon each file change in your working directory:
ADD . .
# Cache deps so that they are not re-fetched on each build.
RUN find . -not -path "./__mocks__/*" -type f \( -iname \*.tsx -o -iname \*.ts \) -exec deno cache {} +

CMD ["deno", "task", "start"]
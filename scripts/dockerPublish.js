    // scripts/dockerPublish.js
    const { execSync } = require('child_process');

    // dotenv should have loaded this from the .env file via dotenv-cli
    const imageName = process.env.DOCKER_IMAGE_NAME;

    // Check if the environment variable is set
    if (!imageName) {
      console.error('\x1b[31mError: DOCKER_IMAGE_NAME environment variable is not set or not loaded.\x1b[0m');
      console.error('Ensure it is defined in your .env file.');
      process.exit(1); // Exit with an error code
    }

    // Function to run shell commands
    const runCommand = (command) => {
      try {
        console.log(`\nExecuting: ${command}`);
        execSync(command, { stdio: 'inherit' }); // stdio: 'inherit' shows output in real-time
      } catch (error) {
        console.error(`\x1b[31mFailed to execute: ${command}\x1b[0m`);
        // error object often contains more details, but execSync throws on non-zero exit code
        process.exit(1); // Exit with an error code
      }
    };

    // Run the docker commands
    console.log(`Using Docker image name: ${imageName}`);
    runCommand(`docker build -t "${imageName}" .`);
    runCommand(`docker push "${imageName}"`);

    console.log('\n\x1b[32mDocker publish completed successfully.\x1b[0m');
    
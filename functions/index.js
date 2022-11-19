'use strict';

const functions = require('firebase-functions');
const { Storage } = require('@google-cloud/storage');
const mkdirp = require('mkdirp');
const admin = require('firebase-admin');
admin.initializeApp();
const spawn = require('child-process-promise').spawn;
const path = require('path');
const os = require('os');
const fs = require('fs');
const speech = require('@google-cloud/speech');
const ffmpeg = require('fluent-ffmpeg');
const ffmpeg_static = require('ffmpeg-static');
const gcs = new Storage();
const language = require('@google-cloud/language');


/**
 * TODO
 */

 const runtimeOpts = {
  timeoutSeconds: 540
 }

exports.transcriptVideo = functions.runWith(runtimeOpts).storage.object().onFinalize(async (object) => {
  // File and directory paths.
  const fileBucket = object.bucket;
  const filePath = object.name;
  const contentType = object.contentType; // This is the video MIME type
  const fileDir = path.dirname(filePath);
  const fileName = path.basename(filePath);
  // const thumbFilePath = path.normalize(path.join(fileDir, `${THUMB_PREFIX}${fileName}`));
  // const tempLocalFile = path.join(os.tmpdir(), filePath);
  // const tempLocalDir = path.dirname(tempLocalFile);
  // const tempLocalThumbFile = path.join(os.tmpdir(), thumbFilePath);

  // Exit if this is triggered on a file that is not a video.
  if (!contentType.startsWith('video/')) {
    return functions.logger.log('Is not a video.');
  }

  // Exit if the audio is already converted.
  if (fileName.endsWith('_output.flac')) {
    functions.logger.log('Already a converted audio.');
    return null;
  }

  const bucket = gcs.bucket(fileBucket);
  const tempFilePath = path.join(os.tmpdir(), fileName);
  // We add a '_output.flac' suffix to target audio file name. That's where we'll upload the converted audio.
  const targetTempFileName = fileName.replace(/\.[^/.]+$/, '') + '_output.flac';
  const targetTempFilePath = path.join(os.tmpdir(), targetTempFileName);
  const targetStorageFilePath = path.join(path.dirname(filePath), targetTempFileName);

  await bucket.file(filePath).download({destination: tempFilePath});
  functions.logger.log('Audio downloaded locally to', tempFilePath);
  // Convert the audio to mono channel using FFMPEG.

  ffmpeg.ffprobe(tempFilePath,function(err, metadata) {
    var audioCodec = null;
    var videoCodec = null;
    metadata.streams.forEach(function(stream){
        if (stream.codec_type === "video")
            videoCodec = stream.codec_name;
        else if (stream.codec_type === "audio")
            audioCodec = stream.codec_name;
    });

    console.log("Video codec: %s\nAudio codec: %s", videoCodec, audioCodec);
});

  let command = ffmpeg(tempFilePath)
      //.setFfmpegPath(ffmpeg_static)
      // .audioChannels(1)
      // .audioFrequency(16000)
      // .format('flac')
      // .outputOptions([
      //   '-vn',
      //   '-acodec copy',
      // ])
      .audioCodec('flac')
      .noVideo()
      .output(targetTempFilePath);

      await promisifyCommand(command);
      functions.logger.log('Output audio created at', targetTempFilePath);
      // Uploading the audio.
      await bucket.upload(targetTempFilePath, {destination: targetStorageFilePath});
      functions.logger.log('Output audio uploaded to', targetStorageFilePath);


  // Instantiates a client
  const client = new speech.SpeechClient();

  // The path to the remote LINEAR16 file
  const gcsUri = 'gs://customerexperiencewatcher.appspot.com/'+targetStorageFilePath;
  functions.logger.log('gcsUri: '+gcsUri)


  const underScorePosition = fileName.indexOf('_');
  const dotPosition = fileName.indexOf('.');
  const taskId = fileName.substring(0,underScorePosition);
  const userId = fileName.substring(underScorePosition+1,dotPosition);

  console.log("underScorePosition: ", underScorePosition)
  console.log("fileDir: ", fileDir);
  console.log("taskId: ", taskId);
  console.log("userId: ", userId);
  

  // Add the URLs to the Database
 // await admin.database().ref('images').push({path: fileUrl, thumbnail: thumbFileUrl});
  await transcribeSpeech(client, gcsUri, fileDir, taskId, userId) 

  // Once the audio has been uploaded delete the local file to free up disk space.
  fs.unlinkSync(tempFilePath);
  fs.unlinkSync(targetTempFilePath);

  return functions.logger.log('finished.');
});


async function transcribeSpeech(client, gcsUri, projectId, taskId, userId) {

  const audio = {
    uri: gcsUri,
  };

  // The audio file's encoding, sample rate in hertz, and BCP-47 language code
  const config = {
    enableAutomaticPunctuation: true,
    //encoding: 'LINEAR16',
    //sampleRateHertz: 16000,
    languageCode: 'es-PE',
    model: "default"
  };

  const request = {
    audio: audio,
    config: config,
  };

  // Detects speech in the audio file
  // const [response] = await client.recognize(request);
  const [operation] = await client.longRunningRecognize(request);
  const [response] = await operation.promise();
  const transcription = response.results
    .map(result => result.alternatives[0].transcript)
    .join('\n');
  console.log(`Transcription: ${transcription}`);

  await analyzeSentiment(transcription, projectId, taskId, userId);
}

async function analyzeSentiment(transcription, projectId, taskId, userId) {
  const client = new language.LanguageServiceClient();

  const document = {
    content: transcription,
    type: 'PLAIN_TEXT',
    language: 'ES',
  };

  // Detects the sentiment of the document
  const [result] = await client.analyzeSentiment({document});

  const sentiment = result.documentSentiment;
  console.log(`Document sentiment:`);
  console.log(`  Score: ${sentiment.score}`);
  console.log(`  Magnitude: ${sentiment.magnitude}`);

  const firestore = admin.firestore();
  const assignmentRef = firestore.collection('assignments');
  const query = assignmentRef.where('id', '==', projectId+taskId)
                            .where('userId','==', userId);
  await query.get().then(function(querySnapshot) {
    querySnapshot.forEach(function(doc) {
        doc.ref.update({
            sentimentScore : sentiment.score,
            sentimentMagnitude : sentiment.magnitude
        });
    });
});

}


// Makes an ffmpeg command return a promise.
function promisifyCommand(command) {
  return new Promise((resolve, reject) => {
    command.on('end', resolve).on('error', reject).run();
  });
}
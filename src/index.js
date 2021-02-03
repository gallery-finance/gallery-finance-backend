var fs = require('fs')
var fastify = require('fastify')()

fastify.register(require('fastify-multipart'))


var util = require('util')
var { pipeline } = require('stream')
var pump = util.promisify(pipeline)
var path = require('path')

var configPath = process.argv[2]

if(configPath == null){
  console.error('no config specified')
  process.exit(1)
}

var config = JSON.parse(fs.readFileSync(configPath))

if(config.allowCors){
  fastify.register(require('fastify-cors'), { 
      origin: true
  })
}

fastify.register(require('fastify-static'), {
  root: config.imageFullDir,
  prefix: config.imageFullRoute,
})
fastify.register(require('fastify-static'), {
  root: config.imagePreviewDir,
  prefix: config.imagePreviewRoute,
  decorateReply: false
})

var dataFilePath = config.datadir + '/' + 'data.json'

if(!fs.existsSync(dataFilePath)){
  fs.writeFileSync(dataFilePath, '[]')
}

var data

function readData(){
  var data = JSON.parse(fs.readFileSync(dataFilePath))
  var byTokenId = {}
  for(var d of data){
    byTokenId[d.tokenId] = d
  }
  return {all: data, byTokenId}
}

function calculateHashtags(data){
  var hashtags = {}
  for(var d of data){
    for(var tag of d.hashtags){
      if(hashtags[tag] == null){
        hashtags[tag] = 0
      }
      hashtags[tag]++
    }
  }
  return Object.entries(hashtags)
    .sort((a,b) => b[1] - a[1])
    .map(tag => tag[0])
}

function addTokenData(d){
  data.all.unshift(d)
  data.byTokenId[d.tokenId] = d
  data.hashtags = calculateHashtags(data.all)
  var tmp = '/tmp/glf-backend-tmp-data.' + Date.now()
  fs.writeFileSync(tmp, JSON.stringify(data.all,undefined,2))
  fs.renameSync(tmp, dataFilePath)
}

data = readData()
data.hashtags = calculateHashtags(data.all)


fastify.setErrorHandler(function (error, request, reply) {
  console.error('error', error)
  var statusCode = error.validation 
    ? 422
    : error.statusCode >= 400 ? error.statusCode : 500
  reply
    .code(statusCode)
    .type('text/plain')
    .send(statusCode >= 500 ? 'Internal server error' : error.message)
})

function formatToken(token){
  token = JSON.parse(JSON.stringify(token))
  token.fullimage = config.imageBasePath + config.imageFullRoute + token.image
  token.image = config.imageBasePath + config.imagePreviewRoute + token.tokenId + '.jpg'
  token.external_url = config.externalUrlBase + token.tokenId
  return token
}

fastify.get('/tokens', async (request, reply) => {
  return {
    tokens: data.all.map(formatToken),
    hashtags: data.hashtags,
  }
})

fastify.get('/tokens/:tokenId', async (request, reply) => {
  var tokenId = parseInt(request.params.tokenId)
  if(isNaN(parseInt(tokenId))){
    var error = new Error('invalid token id')
    error.statusCode = 422
    reply.send(error)
    return
  }
  var d = data.byTokenId[tokenId]
  if(d == null){
    var error = new Error('token does not exist')
    error.statusCode = 422
    reply.send(error)
    return
  }
  var token =  formatToken(d)
  token.attributes = [
    {
      trait_type: 'Date of creation',
      display_type: 'date',
      value: Math.floor(new Date(d.dateCreated).getTime()/1000),
    },
    {
      trait_type: 'Artist',
      value: token.artist,
    },
  ]
  if(token.hashtags.length > 0){
    token.attributes.push({
      trait_type: 'Tags',
      value: token.hashtags.join(' '),
    })
  }

  return token
})


fastify.route({
  url: '/tokens',
  method: 'POST',
  handler: async (request, reply) => {

		var parts = await request.parts()

    var params = {}

		for await (var part of parts) {
      console.log('parsing multipart', part.fieldname)
      params[part.fieldname] = part.value


      if(part.fieldname == 'tokenId'){
        var tokenId = part.value
        tokenId = parseInt(tokenId)
        console.log('uploading metadata for ' + tokenId)
        if(isNaN(tokenId)){
          var error = new Error('invalid token id')
          error.statusCode = 422
          reply.send(error)
          return
        }
        if(data.byTokenId[tokenId] != null){
          var error = new Error('tokenId already exists')
          error.statusCode = 422
          reply.send(error)
          return
        }
      }

      if(part.fieldname == 'hashtags'){
        var hashtags = params['hashtags']
        hashtags = (hashtags || '').split(/[^\w]+/).filter(tag => tag != '')
      }


      if(part.fieldname == 'image'){
        console.log('saving full image' + tokenId)
        var imagePath = tokenId.toString() + path.extname(part.filename)
        var targetPath = config.imageFullDir + '/' + imagePath
        await pump(part.file, fs.createWriteStream(targetPath))
        console.log('saved full image' + tokenId)
      }

      if(part.fieldname == 'preview'){
        console.log('saving preview' + tokenId)
        var targetPreviewPath = config.imagePreviewDir + '/' + tokenId + '.jpg'
        await pump(part.file, fs.createWriteStream(targetPreviewPath))
        console.log('saved preview' + tokenId)
      }

		}

    var result = {
      tokenId,
      name: params.name,
      artist: params.artist,
      hashtags,
      description: params.description,
      owner: params.owner,
      txHash: params.txHash,
    }


    result.image = imagePath
    result.dateCreated = new Date().toISOString()

    console.log('saving data', result)

    addTokenData(result)

    reply.send(result)
  }
})

const start = async () => {
  try {
    await fastify.listen(config.port)
    console.log(`server listening on ${fastify.server.address().port}`)
  } catch (err) {
    console.error(err)
    process.exit(1)
  }
}
start()

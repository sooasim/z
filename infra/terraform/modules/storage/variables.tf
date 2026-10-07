variable "name" {
  type = string
}

variable "bucket_suffix" {
  description = "Globally-unique suffix (e.g. AWS account id)"
  type        = string
}

variable "upload_origins" {
  description = "Browser origins allowed to PUT presigned uploads"
  type        = list(string)
}

variable "cloudfront_distribution_arn" {
  description = "Media distribution allowed to read the public bucket via OAC (empty on first apply)"
  type        = string
  default     = ""
}

variable "enable_cloudfront_oac" {
  description = "Grant the media CloudFront distribution read access (known at plan time)"
  type        = bool
  default     = true
}

variable "force_destroy" {
  type    = bool
  default = false
}

variable "tags" {
  type    = map(string)
  default = {}
}
